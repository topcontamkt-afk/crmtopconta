import { PrismaClient } from "@prisma/client";
import { ChannelAdapter } from "./channels/types";
import { MockSMSAdapter, TwilioSMSAdapter } from "./channels/sms";
import { MockWhatsAppAdapter, WhatsAppCloudAdapter } from "./channels/whatsapp";
import { buildSegmentWhere, SegmentFilters } from "./segments";

/**
 * Processamento de fila de campanha.
 * Regras aplicadas antes de cada envio:
 *  - exclui clientes sem autorizacao_comunicacao (opt-out) ou com optOutAt preenchido;
 *  - respeita a janela mínima de dedupe (dedupeWindowHrs) por cliente+template;
 *  - respeita o throttle configurado (throttlePerMin) via espaçamento entre envios.
 * Em produção isso roda em workers dedicados por canal, consumindo de uma fila real
 * (RabbitMQ/Redis Streams) — aqui a fila é modelada em Postgres (MessageEvent status=FILA)
 * para manter o MVP sem dependências de infra extras, com a mesma interface de domínio.
 */

function resolveAdapter(channel: "WHATSAPP" | "SMS"): ChannelAdapter {
  if (channel === "WHATSAPP") {
    const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    if (phoneId && token) return new WhatsAppCloudAdapter(phoneId, token);
    return new MockWhatsAppAdapter();
  }
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (sid && authToken && from) return new TwilioSMSAdapter(sid, authToken, from);
  return new MockSMSAdapter();
}

export function renderTemplate(template: string, client: Record<string, any>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const value = client[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

/** Monta o público da campanha a partir do segmento salvo ou de filtros ad-hoc, sempre excluindo opt-outs. */
export async function buildAudience(prisma: PrismaClient, tenantId: string, campaignId: string) {
  const campaign = await prisma.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    include: { segment: true },
  });

  const filters: SegmentFilters = (campaign.segment?.filters as SegmentFilters) || (campaign.adHocFilters as SegmentFilters) || {};
  const where = buildSegmentWhere(tenantId, filters);

  return prisma.client.findMany({
    where: {
      ...where,
      autorizacaoComunicacao: true,
      optOutAt: null,
      statusConta: { not: "BLOQUEADO" },
    },
  });
}

/** Enfileira MessageEvents (status FILA) para todos os clientes elegíveis, aplicando a janela de dedupe. */
export async function enqueueCampaign(prisma: PrismaClient, tenantId: string, campaignId: string) {
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const audience = await buildAudience(prisma, tenantId, campaignId);

  const dedupeCutoff = new Date(Date.now() - campaign.dedupeWindowHrs * 60 * 60 * 1000);
  let queued = 0;
  let skippedDedupe = 0;

  for (const client of audience) {
    const recentSameCampaignType = await prisma.messageEvent.findFirst({
      where: {
        clientId: client.id,
        campaign: { messageTemplate: campaign.messageTemplate, tenantId },
        queuedAt: { gte: dedupeCutoff },
      },
    });
    if (recentSameCampaignType) {
      skippedDedupe++;
      continue;
    }

    await prisma.messageEvent.create({
      data: {
        campaignId,
        clientId: client.id,
        channel: campaign.channel,
        status: "FILA",
      },
    });
    queued++;
  }

  await prisma.campaign.update({
    where: { id: campaignId },
    data: { audienceCount: audience.length, status: "AGENDADA" },
  });

  return { audienceSize: audience.length, queued, skippedDedupe };
}

/**
 * Processa até `limit` mensagens em FILA respeitando o throttle (msgs/min) da campanha.
 * Pensado para ser chamado periodicamente por um worker/cron.
 */
export async function processQueueBatch(prisma: PrismaClient, campaignId: string, limit = 50) {
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const adapter = resolveAdapter(campaign.channel);

  const batchSize = Math.min(limit, campaign.throttlePerMin);
  const pending = await prisma.messageEvent.findMany({
    where: { campaignId, status: "FILA" },
    take: batchSize,
    include: { client: true },
  });

  const results = [];
  for (const evt of pending) {
    if (!evt.client.autorizacaoComunicacao || evt.client.optOutAt) {
      await prisma.messageEvent.update({
        where: { id: evt.id },
        data: { status: "BLOQUEADO", error: "Cliente sem autorização/opt-out" },
      });
      continue;
    }

    const body = renderTemplate(campaign.messageTemplate, {
      nome: evt.client.nome,
      cidade: evt.client.cidade,
      percentual: evt.client.percentualUtilizado,
    });

    const sendResult = await adapter.send(evt.client.telefone, body);

    await prisma.messageEvent.update({
      where: { id: evt.id },
      data: {
        status: sendResult.status === "SENT" ? "ENVIADO" : "FALHA",
        providerMsgId: sendResult.providerMessageId || undefined,
        error: sendResult.error,
        cost: sendResult.cost ?? campaign.costPerMessage,
        sentAt: sendResult.status === "SENT" ? new Date() : undefined,
      },
    });
    results.push({ clientId: evt.clientId, status: sendResult.status });
  }

  const remaining = await prisma.messageEvent.count({ where: { campaignId, status: "FILA" } });
  if (remaining === 0) {
    await prisma.campaign.update({ where: { id: campaignId }, data: { status: "CONCLUIDA" } });
  } else {
    await prisma.campaign.update({ where: { id: campaignId }, data: { status: "EM_EXECUCAO" } });
  }

  return { processed: results.length, remaining, results };
}

/**
 * Atribuição de conversão: para cada MessageEvent ENTREGUE/RESPONDIDO, verifica se houve
 * Movement do cliente dentro da janela (campaign.attributionDays) após o envio. Regra de
 * exclusividade: primeira movimentação dentro da janela conta como conversão.
 */
export async function computeAttribution(prisma: PrismaClient, campaignId: string) {
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const events = await prisma.messageEvent.findMany({
    where: { campaignId, status: { in: ["ENVIADO", "ENTREGUE", "LIDO", "RESPONDIDO"] }, convertedAt: null },
  });

  let conversions = 0;
  for (const evt of events) {
    if (!evt.sentAt) continue;
    const windowEnd = new Date(evt.sentAt.getTime() + campaign.attributionDays * 24 * 60 * 60 * 1000);
    const movement = await prisma.movement.findFirst({
      where: { clientId: evt.clientId, data: { gte: evt.sentAt, lte: windowEnd } },
      orderBy: { data: "asc" },
    });
    if (movement) {
      await prisma.messageEvent.update({ where: { id: evt.id }, data: { convertedAt: movement.data } });
      conversions++;
    }
  }
  return { evaluated: events.length, conversions };
}

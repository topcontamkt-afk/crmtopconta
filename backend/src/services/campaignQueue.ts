import { AppPrismaClient } from "../config/db";
import { ChannelAdapter, SendResult } from "./channels/types";
import { MockSMSAdapter, TwilioSMSAdapter, ZenviaSMSAdapter } from "./channels/sms";
import { MockWhatsAppAdapter, WhatsAppCloudAdapter } from "./channels/whatsapp";
import { buildSegmentWhere, SegmentFilters, SegmentGroup } from "./segments";
import { decryptSecret, isEncryptedPayload } from "./crypto";

/**
 * Processamento de fila de campanha.
 * Regras aplicadas antes de cada envio:
 *  - exclui clientes sem autorizacao_comunicacao (opt-out) ou com optOutAt preenchido;
 *  - respeita a janela mínima de dedupe (dedupeWindowHrs) por cliente+template;
 *  - respeita o throttle configurado (throttlePerMin) e o rate limit global do tenant
 *    (Tenant.maxMsgsPerMinute — Fase 2);
 *  - tenta os provedores do canal em ordem de prioridade, com failover automático em falha
 *    (Fase 2 — multi-provider SMS).
 * Em produção isso roda em workers dedicados por canal, consumindo de uma fila real
 * (RabbitMQ/Redis Streams) — aqui a fila é modelada em Postgres (MessageEvent status=FILA)
 * para manter o MVP sem dependências de infra extras, com a mesma interface de domínio.
 */

interface ResolvedProvider {
  name: string;
  adapter: ChannelAdapter;
}

function instantiateAdapter(channel: "WHATSAPP" | "SMS", provider: string, creds: Record<string, any>): ChannelAdapter | null {
  if (channel === "WHATSAPP" && provider === "whatsapp_cloud_api") {
    return new WhatsAppCloudAdapter(creds.phoneNumberId, creds.accessToken);
  }
  if (channel === "SMS" && provider === "twilio") {
    return new TwilioSMSAdapter(creds.accountSid, creds.authToken, creds.fromNumber);
  }
  if (channel === "SMS" && provider === "zenvia") {
    return new ZenviaSMSAdapter(creds.apiToken, creds.fromNumber);
  }
  return null;
}

/**
 * Resolve a lista ordenada de provedores ativos do tenant para o canal (menor priority primeiro).
 * Se o tenant não configurou nenhum ChannelConfig (ainda comum em ambiente de dev/sandbox),
 * cai para o adaptador único baseado em variáveis de ambiente (compatibilidade com a Fase 1),
 * e na ausência total de credenciais usa o adaptador mock.
 */
async function resolveProviders(
  prisma: AppPrismaClient,
  tenantId: string,
  channel: "WHATSAPP" | "SMS"
): Promise<ResolvedProvider[]> {
  const configs = await prisma.channelConfig.findMany({
    where: { tenantId, channel, active: true },
    orderBy: { priority: "asc" },
  });

  const resolved: ResolvedProvider[] = [];
  for (const cfg of configs) {
    try {
      const payload = cfg.credentials as any;
      const creds = isEncryptedPayload(payload) ? decryptSecret(payload) : payload;
      const adapter = instantiateAdapter(channel, cfg.provider, creds);
      if (adapter) resolved.push({ name: cfg.provider, adapter });
    } catch (e) {
      // credencial corrompida/chave de cifra ausente: pula este provedor em vez de derrubar o dispatch
      console.error(`[campaignQueue] Falha ao decifrar credenciais de ${cfg.provider}:`, e);
    }
  }

  if (resolved.length > 0) return resolved;

  // Fallback env-based (Fase 1)
  if (channel === "WHATSAPP") {
    const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    if (phoneId && token) return [{ name: "whatsapp_cloud_api", adapter: new WhatsAppCloudAdapter(phoneId, token) }];
    return [{ name: "mock", adapter: new MockWhatsAppAdapter() }];
  }
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (sid && authToken && from) return [{ name: "twilio", adapter: new TwilioSMSAdapter(sid, authToken, from) }];
  return [{ name: "mock", adapter: new MockSMSAdapter() }];
}

/** Tenta os provedores em ordem até um SENT, ou retorna a última falha (failover multi-provider). */
async function sendWithFailover(
  providers: ResolvedProvider[],
  to: string,
  body: string
): Promise<SendResult & { provider: string }> {
  let last: SendResult = { providerMessageId: "", status: "FAILED", error: "Nenhum provedor configurado" };
  for (const p of providers) {
    const result = await p.adapter.send(to, body);
    if (result.status === "SENT") return { ...result, provider: p.name };
    last = result;
  }
  return { ...last, provider: providers[providers.length - 1]?.name ?? "none" };
}

const brl = (n: unknown) => Number(n ?? 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/** Contexto de renderização de um cliente real (usado no envio). */
export function templateContext(client: {
  nome: string;
  cidade: string | null;
  percentualUtilizado: unknown;
  saldoDisponivel: unknown;
  limiteTotal: unknown;
}): Record<string, unknown> {
  return {
    nome: client.nome,
    cidade: client.cidade,
    percentual: client.percentualUtilizado,
    saldo: brl(client.saldoDisponivel),
    limite: brl(client.limiteTotal),
  };
}

export function renderTemplate(template: string, client: Record<string, any>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const value = client[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

/** Monta o público da campanha a partir do segmento salvo ou de filtros ad-hoc, sempre excluindo opt-outs. */
export async function buildAudience(prisma: AppPrismaClient, tenantId: string, campaignId: string) {
  const campaign = await prisma.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    include: { segment: true },
  });

  const filters: SegmentFilters | SegmentGroup =
    (campaign.segment?.filters as any) || (campaign.adHocFilters as any) || {};
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

/**
 * Enfileira MessageEvents (status FILA) para todos os clientes elegíveis, aplicando a janela de
 * dedupe e sorteando a variante A/B quando a campanha tem variantSplitPercent configurado.
 */
export async function enqueueCampaign(prisma: AppPrismaClient, tenantId: string, campaignId: string) {
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const audience = await buildAudience(prisma, tenantId, campaignId);

  const dedupeCutoff = new Date(Date.now() - campaign.dedupeWindowHrs * 60 * 60 * 1000);
  let queued = 0;
  let control = 0;
  let skippedDedupe = 0;

  for (const client of audience) {
    const recentSameCampaignType = await prisma.messageEvent.findFirst({
      where: {
        clientId: client.id,
        campaign: { messageTemplate: campaign.messageTemplate, tenantId },
        queuedAt: { gte: dedupeCutoff },
        // Quem ficou no grupo de controle de uma campanha anterior NÃO recebeu a mensagem, então
        // não conta para a janela de dedupe (senão seria excluído de campanhas futuras à toa).
        status: { not: "CONTROLE" },
      },
    });
    if (recentSameCampaignType) {
      skippedDedupe++;
      continue;
    }

    // Grupo de controle (opcional): parte do público fica de fora do envio, só para comparar o uso
    // de quem recebeu com o de quem não recebeu. É sorteado ANTES da variante A/B, para o
    // controle não distorcer a divisão entre A e B.
    if (campaign.controlGroupPercent && Math.random() * 100 < campaign.controlGroupPercent) {
      await prisma.messageEvent.create({
        data: { campaignId, clientId: client.id, channel: campaign.channel, status: "CONTROLE", variant: "A" },
      });
      control++;
      continue;
    }

    const variant =
      campaign.variantSplitPercent && Math.random() * 100 < campaign.variantSplitPercent ? "B" : "A";

    await prisma.messageEvent.create({
      data: {
        campaignId,
        clientId: client.id,
        channel: campaign.channel,
        status: "FILA",
        variant,
      },
    });
    queued++;
  }

  await prisma.campaign.update({
    where: { id: campaignId },
    data: { audienceCount: audience.length, status: "AGENDADA" },
  });

  return { audienceSize: audience.length, queued, control, skippedDedupe };
}

/** Quantas mensagens já foram enviadas pelo tenant no último minuto (para o rate limit global). */
async function sentInLastMinute(prisma: AppPrismaClient, tenantId: string): Promise<number> {
  const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
  return prisma.messageEvent.count({
    where: { campaign: { tenantId }, sentAt: { gte: oneMinuteAgo } },
  });
}

/**
 * Processa até `limit` mensagens em FILA respeitando o throttle da campanha E o rate limit
 * global do tenant (Tenant.maxMsgsPerMinute), com failover entre provedores do canal.
 */
export async function processQueueBatch(prisma: AppPrismaClient, campaignId: string, limit = 50) {
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: campaign.tenantId } });
  const providers = await resolveProviders(prisma, campaign.tenantId, campaign.channel);

  const alreadySentThisMinute = await sentInLastMinute(prisma, campaign.tenantId);
  const tenantBudget = Math.max(0, tenant.maxMsgsPerMinute - alreadySentThisMinute);
  const batchSize = Math.min(limit, campaign.throttlePerMin, tenantBudget);

  if (batchSize <= 0) {
    return { processed: 0, remaining: await prisma.messageEvent.count({ where: { campaignId, status: "FILA" } }), results: [], throttled: true };
  }

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

    const templateBody = evt.variant === "B" && campaign.messageTemplateB ? campaign.messageTemplateB : campaign.messageTemplate;
    const body = renderTemplate(templateBody, templateContext(evt.client));

    const sendResult = await sendWithFailover(providers, evt.client.telefone, body);

    await prisma.messageEvent.update({
      where: { id: evt.id },
      data: {
        status: sendResult.status === "SENT" ? "ENVIADO" : "FALHA",
        provider: sendResult.provider,
        providerMsgId: sendResult.providerMessageId || undefined,
        error: sendResult.error,
        cost: sendResult.cost ?? campaign.costPerMessage,
        sentAt: sendResult.status === "SENT" ? new Date() : undefined,
      },
    });
    results.push({ clientId: evt.clientId, status: sendResult.status, provider: sendResult.provider });
  }

  const remaining = await prisma.messageEvent.count({ where: { campaignId, status: "FILA" } });
  if (remaining === 0) {
    await prisma.campaign.update({ where: { id: campaignId }, data: { status: "CONCLUIDA" } });
  } else {
    await prisma.campaign.update({ where: { id: campaignId }, data: { status: "EM_EXECUCAO" } });
  }

  return { processed: results.length, remaining, results, throttled: false };
}

/**
 * Sandbox de campanhas (Fase 2): envia a mensagem (variante A) diretamente para uma pequena
 * lista de telefones informados manualmente, sem tocar no público real nem gerar MessageEvents
 * — útil para QA antes de agendar a campanha para a base completa.
 */
export async function sendTestMessages(
  prisma: AppPrismaClient,
  tenantId: string,
  campaignId: string,
  phones: string[]
) {
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const providers = await resolveProviders(prisma, tenantId, campaign.channel);

  const sample = { nome: "Cliente Teste", cidade: "São Paulo", percentual: 42, saldo: brl(850), limite: brl(1500) };
  const body = renderTemplate(campaign.messageTemplate, sample);

  const results = [];
  for (const phone of phones) {
    const sendResult = await sendWithFailover(providers, phone, body);
    results.push({ phone, status: sendResult.status, provider: sendResult.provider, error: sendResult.error });
  }
  return { body, results };
}

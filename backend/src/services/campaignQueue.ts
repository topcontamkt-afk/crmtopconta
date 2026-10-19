import { AppPrismaClient } from "../config/db";
import { buscarEmPartes } from "../config/d1Partes";
import { ChannelAdapter, SendResult } from "./channels/types";
import { MockSMSAdapter, TwilioSMSAdapter, ZenviaSMSAdapter } from "./channels/sms";
import { MockWhatsAppAdapter, WhatsAppCloudAdapter } from "./channels/whatsapp";
import { ZAPI_BATCH_MAX, ZapiAdapter } from "./channels/zapi";
import { zapiCredentialsOf } from "./zapi";
import { AVISO_RENDA_IGNORADA, buildSegmentWhere, ENVIAVEL_WHERE, filtrosRendaIgnorados, SegmentFilters, SegmentGroup } from "./segments";
import { templateParams, templatePreview } from "./whatsappTemplates";
import { unmappedPositions } from "./templateImport";
import { makeToken, trackedButtons } from "./trackedLinks";
import { recordOutboundTemplateMessage } from "./whatsappInbox";
import { credentialsOf, globalCredentialsAllowed } from "./whatsappAccount";
import { CONTATO_LIBERADO_WHERE, contatoSuprimido, motivoBloqueioCliente, semSuprimidos, suprimidosEmLote, textoSupressao, canonicalPhone } from "./privacy";
import { decryptSecret, isEncryptedPayload } from "./crypto";
import { brl, recipientContext, renderTemplate, templateContext, usesLimiteDisponivel } from "./messageContext";
import { comRodape, montarRodape } from "./templateVariables";
import { baseLegalVigente, motivoSemBaseLegal } from "./baseLegal";
import { loadTemplateMedia } from "./mediaStore";
export { recipientContext, renderTemplate, templateContext, usesLimiteDisponivel };

/**
 * Processamento de fila de campanha.
 * Regras aplicadas antes de cada envio:
 *  - exclui clientes sem autorizacao_comunicacao (opt-out), com optOutAt ou bloqueadoLgpdAt preenchido;
 *  - LGPD 02-03: exclui todo contato (cliente OU destinatário de lista) cujo telefone/documento está
 *    suprimido (SupressaoTitular) ou que pediu para parar por qualquer registro com o mesmo número;
 *  - respeita a janela mínima de dedupe (dedupeWindowHrs) por cliente+template;
 *  - respeita o throttle configurado (throttlePerMin) e o rate limit global do tenant
 *    (Tenant.maxMsgsPerMinute — Fase 2);
 *  - tenta os provedores do canal em ordem de prioridade, com failover automático em falha
 *    (Fase 2 — multi-provider SMS);
 *  - LGPD 02-01: nada é enfileirado nem enviado sem base legal declarada pelo tenant (Configurações → LGPD);
 *  - LGPD 02-05/02-07: texto livre (SMS, Z-API, WhatsApp sem template da Meta) sempre leva o rodapé do
 *    controlador com a instrução de descadastro (`montarRodape`). Template da Meta vai como aprovado.
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

/** Mensagem do bloqueio quando o tenant não tem provedor próprio para o canal (LGPD 06-01). */
export function semProvedorMotivo(channel: "WHATSAPP" | "SMS"): string {
  return channel === "WHATSAPP"
    ? "Nenhum WhatsApp configurado para esta empresa: configure o canal do tenant em Integrações → WhatsApp (ou Configurações → WhatsApp, para a Z-API). Nada foi enviado."
    : "Nenhum provedor de SMS configurado para esta empresa: configure o canal do tenant em Configurações → Canais. Nada foi enviado.";
}

/**
 * Resolve a lista ordenada de provedores ativos do tenant para o canal (menor priority primeiro).
 *
 * LGPD 06-01: o tráfego de um tenant só sai pelos provedores que ELE configurou (ChannelConfig ou
 * WhatsAppAccount). A credencial global do ambiente (WHATSAPP_*, TWILIO_*) só vale quando liberada de
 * propósito (`ALLOW_GLOBAL_CHANNEL_CREDENTIALS=true`, dev) ou para o tenant dono dela
 * (`PLATFORM_DEFAULT_TENANT_ID`); ver `globalCredentialsAllowed`. Fora disso: mock fora de produção (dev,
 * testes) e lista VAZIA em produção, o que bloqueia o disparo com `semProvedorMotivo` em vez de enviar os
 * dados dos clientes por uma conta que a controladora não escolheu.
 */
async function resolveProviders(
  prisma: AppPrismaClient,
  tenantId: string,
  channel: "WHATSAPP" | "SMS"
): Promise<ResolvedProvider[]> {
  // Conexão ativa em Configurações → WhatsApp: Z-API (não oficial, texto livre) no lugar da Meta. Sem credencial
  // válida devolve lista VAZIA: o disparo bloqueia com aviso em vez de cair na Meta sem o usuário perceber.
  if (channel === "WHATSAPP") {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { whatsappProvider: true } });
    if (tenant?.whatsappProvider === "ZAPI") {
      const account = await prisma.whatsAppAccount.findFirst({ where: { tenantId, provider: "ZAPI", active: true }, orderBy: { createdAt: "asc" } });
      const creds = zapiCredentialsOf(account);
      return creds ? [{ name: "zapi", adapter: new ZapiAdapter(creds) }] : [];
    }
  }

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

  // WhatsApp configurado pela tela de Integrações (WhatsAppAccount, credenciais cifradas)
  if (channel === "WHATSAPP") {
    const account = await prisma.whatsAppAccount.findFirst({ where: { tenantId, active: true, provider: "META" }, orderBy: { createdAt: "asc" } });
    const token = credentialsOf(account).accessToken;
    if (account && token && account.credentials) return [{ name: "whatsapp_cloud_api", adapter: new WhatsAppCloudAdapter(account.phoneNumberId, token) }];
  }

  // Reserva pela credencial do ambiente (Fase 1): só com liberação explícita (LGPD 06-01)
  if (globalCredentialsAllowed(tenantId)) {
    if (channel === "WHATSAPP") {
      const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
      const token = process.env.WHATSAPP_ACCESS_TOKEN;
      if (phoneId && token) return [{ name: "whatsapp_cloud_api", adapter: new WhatsAppCloudAdapter(phoneId, token) }];
    } else {
      const sid = process.env.TWILIO_ACCOUNT_SID;
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      const from = process.env.TWILIO_FROM_NUMBER;
      if (sid && authToken && from) return [{ name: "twilio", adapter: new TwilioSMSAdapter(sid, authToken, from) }];
    }
  }
  // Mock (só simula) só com MESSAGING_MODE=mock (local/homologação); sem isso, sem provedor do tenant não há envio.
  // Antes era "fora de produção" pelo NODE_ENV, que no Worker não diz em qual ambiente se está.
  if (process.env.MESSAGING_MODE !== "mock") return [];
  return [{ name: "mock", adapter: channel === "WHATSAPP" ? new MockWhatsAppAdapter() : new MockSMSAdapter() }];
}

/** O tenant tem um WhatsApp REAL conectado (senão o envio cai no mock, que só simula)? */
export async function hasRealWhatsApp(prisma: AppPrismaClient, tenantId: string): Promise<boolean> {
  const providers = await resolveProviders(prisma, tenantId, "WHATSAPP");
  return providers.some((p) => p.name !== "mock");
}

/** Tenta os provedores em ordem até um SENT, ou retorna a última falha (failover multi-provider). */
async function sendWithFailover(
  providers: ResolvedProvider[],
  to: string,
  body: string,
  template?: { name: string; language: string; params: string[]; headerImageId?: string; buttonTokens?: { index: number; token: string }[] }
): Promise<SendResult & { provider: string }> {
  let last: SendResult = { providerMessageId: "", status: "FAILED", error: "Nenhum provedor configurado" };
  for (const p of providers) {
    // Template da Meta: só adaptadores que sabem enviá-lo; os outros caem para o próximo provedor.
    if (template && !p.adapter.sendTemplate) continue;
    const result = template ? await p.adapter.sendTemplate!(to, template) : await p.adapter.send(to, body);
    if (result.status === "SENT") return { ...result, provider: p.name };
    last = result;
  }
  return { ...last, provider: providers[providers.length - 1]?.name ?? "none" };
}

/**
 * WhatsApp com provedor REAL só envia template APROVADO pela Meta (a primeira mensagem de uma
 * campanha é fora da janela de 24h; texto livre seria recusado). Sem provedor real (mock/dev) o
 * comportamento antigo de texto livre continua. Devolve o template a usar, ou o motivo do bloqueio.
 */
export async function resolveWhatsAppTemplate(
  prisma: AppPrismaClient,
  campaign: { tenantId: string; channel: string; templateId: string | null },
  providers: ResolvedProvider[]
): Promise<{ template: any | null; bloqueado?: string }> {
  if (campaign.channel !== "WHATSAPP") return { template: null };
  if (providers.length === 0) return { template: null, bloqueado: semProvedorMotivo("WHATSAPP") };
  // Z-API: texto livre (o texto do template, com as variáveis preenchidas); nada é enviado como template da Meta
  if (providers[0].name === "zapi") return { template: null };
  const real = providers.some((p) => p.name !== "mock");
  const template = campaign.templateId ? await prisma.messageTemplate.findFirst({ where: { id: campaign.templateId, tenantId: campaign.tenantId } }) : null;
  const usable = !!template && template.channel === "WHATSAPP" && template.status === "APROVADO" && !!template.metaName && template.metaStatus === "APPROVED";
  if (usable) {
    // Template importado da Meta: só envia se todas as variáveis estão mapeadas e o formato é suportado.
    if (template!.sendIssue) return { template: null, bloqueado: `O template "${template!.name}" não pode ser enviado por aqui: ${template!.sendIssue}` };
    const faltam = unmappedPositions(template!.variableMap as (string | null)[] | null);
    if (faltam.length) return { template: null, bloqueado: `Defina o que cada variável do template "${template!.name}" significa (faltam: ${faltam.map((n) => `{{${n}}}`).join(", ")}).` };
    return { template };
  }
  if (!real) return { template: null };
  if (!template) return { template: null, bloqueado: "No WhatsApp a campanha precisa de um template aprovado pela Meta. Escolha um template na campanha." };
  return { template: null, bloqueado: `O template "${template.name}" ainda não está aprovado pela Meta (status: ${template.metaStatus ?? "não enviado"}).` };
}

/**
 * Template com imagem no cabeçalho: sobe a imagem para a Meta uma vez por lote e devolve o id usado em
 * todos os envios do lote (o id vale por ~30 dias, mas subir de novo é barato e evita id vencido).
 */
export async function prepareHeaderImage(
  prisma: AppPrismaClient,
  tenantId: string,
  template: { id: string; headerFormat?: string | null; name: string } | null,
  providers: ResolvedProvider[]
): Promise<{ imageId?: string; bloqueado?: string }> {
  if (!template || template.headerFormat !== "IMAGE") return {};
  const media = await loadTemplateMedia(prisma, tenantId, template.id);
  if (!media) return { bloqueado: `O template "${template.name}" precisa da imagem do cabeçalho (Templates > imagem).` };
  const provider = providers.find((p) => p.adapter.uploadHeaderImage);
  if (!provider) return { bloqueado: "Nenhum provedor de WhatsApp consegue enviar a imagem do cabeçalho." };
  try {
    return { imageId: await provider.adapter.uploadHeaderImage!(media.data, media.mime, media.filename) };
  } catch (e: any) {
    return { bloqueado: `Não consegui enviar a imagem do cabeçalho à Meta: ${e.message}` };
  }
}

/**
 * Monta o público da campanha a partir do segmento salvo ou de filtros ad-hoc, sempre excluindo opt-outs,
 * bloqueios a pedido do titular e telefones/documentos suprimidos (LGPD 02-03).
 */
export async function buildAudience(prisma: AppPrismaClient, tenantId: string, campaignId: string) {
  const campaign = await prisma.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    include: { segment: true },
  });

  const filters: SegmentFilters | SegmentGroup =
    (campaign.segment?.filters as any) || (campaign.adHocFilters as any) || {};
  const where = buildSegmentWhere(tenantId, filters);

  // lista de clientes (dashboard, comércio, ciclo, automação) pode ter milhares de ids: em pedaços para o D1
  const clientes = await buscarEmPartes(
    {
      ...where,
      ...CONTATO_LIBERADO_WHERE,
      statusConta: { not: "BLOQUEADO" as const },
      // sem limite = comércio credenciado, nunca é público de disparo de cartão
      ...ENVIAVEL_WHERE,
    },
    (w) => prisma.client.findMany({ where: w })
  );
  // LGPD 02-03: o pedido para parar vale pelo TELEFONE (outro cadastro com o mesmo número, contato de lista)
  return semSuprimidos(prisma, tenantId, clientes);
}

/**
 * Enfileira MessageEvents (status FILA) para todos os clientes elegíveis, aplicando a janela de
 * dedupe e sorteando a variante A/B quando a campanha tem variantSplitPercent configurado.
 */
export async function enqueueCampaign(
  prisma: AppPrismaClient,
  tenantId: string,
  campaignId: string
): Promise<{ audienceSize: number; queued: number; control: number; skippedDedupe: number; bloqueados?: number; bloqueado?: string }> {
  // LGPD 02-01: sem base legal declarada nada entra na fila (campanha, lista manual e automação passam aqui)
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { baseLegalMarketing: true } });
  const semBase = motivoSemBaseLegal(tenant);
  if (semBase) return { audienceSize: 0, queued: 0, control: 0, skippedDedupe: 0, bloqueado: semBase };

  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId }, include: { segment: true } });
  if (campaign.manual) return enqueueManualCampaign(prisma, tenantId, campaign);
  // LGPD 01-03: segmento antigo com filtro de renda (que não vale mais) ampliaria o público em silêncio
  if (filtrosRendaIgnorados(campaign.segment?.filters ?? campaign.adHocFilters).length) {
    return { audienceSize: 0, queued: 0, control: 0, skippedDedupe: 0, bloqueado: AVISO_RENDA_IGNORADA };
  }
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
        data: { tenantId, campaignId, clientId: client.id, channel: campaign.channel, status: "CONTROLE", variant: "A" },
      });
      control++;
      continue;
    }

    const variant =
      campaign.variantSplitPercent && Math.random() * 100 < campaign.variantSplitPercent ? "B" : "A";

    await prisma.messageEvent.create({
      data: {
        tenantId,
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

/** Por que o destinatário de lista não pode receber (opt-out dele, do cliente ligado, ou supressão), ou null. */
function motivoBloqueioDestinatario(
  r: { telefone: string; cpfHash: string | null; optOutAt: Date | null; client: { autorizacaoComunicacao: boolean; optOutAt: Date | null; bloqueadoLgpdAt: Date | null; cpfHash: string | null } | null },
  lote: Awaited<ReturnType<typeof suprimidosEmLote>>
): string | null {
  if (r.optOutAt) return "Destinatário pediu para não receber (opt-out)";
  const doCliente = motivoBloqueioCliente(r.client);
  if (doCliente) return doCliente;
  const canon = canonicalPhone(r.telefone);
  if (contatoSuprimido(lote, { telefone: r.telefone, cpfHash: r.cpfHash }) || contatoSuprimido(lote, { cpfHash: r.client?.cpfHash })) {
    return textoSupressao(canon ? lote.motivos.get(canon) : null);
  }
  return null;
}

/**
 * Campanha de lista (planilha): o público são os destinatários guardados; cada um entra na fila uma
 * única vez (reagendar não duplica). LGPD 02-03: quem virou opt-out (por qualquer registro com o mesmo
 * telefone) ou foi suprimido depois de criada a lista entra como BLOQUEADO, com o motivo; o envio confere
 * de novo, para quem pedir para parar entre o agendamento e o disparo.
 */
export async function enqueueManualCampaign(prisma: AppPrismaClient, tenantId: string, campaign: { id: string; channel: any }) {
  const recipients = await prisma.campaignRecipient.findMany({
    where: { tenantId, campaignId: campaign.id },
    select: {
      id: true,
      clientId: true,
      telefone: true,
      cpfHash: true,
      optOutAt: true,
      client: { select: { autorizacaoComunicacao: true, optOutAt: true, bloqueadoLgpdAt: true, cpfHash: true } },
      messageEvents: { select: { id: true }, take: 1 },
    },
  });
  const novos = recipients.filter((r) => r.messageEvents.length === 0);
  const lote = await suprimidosEmLote(prisma, tenantId, {
    telefones: novos.map((r) => r.telefone),
    docHashes: novos.flatMap((r) => [r.cpfHash, r.client?.cpfHash]),
  });
  let bloqueados = 0;
  for (let i = 0; i < novos.length; i += 500) {
    await prisma.messageEvent.createMany({
      data: novos.slice(i, i + 500).map((r) => {
        const motivo = motivoBloqueioDestinatario(r, lote);
        if (motivo) bloqueados++;
        return { tenantId, campaignId: campaign.id, clientId: r.clientId, recipientId: r.id, channel: campaign.channel, status: motivo ? ("BLOQUEADO" as const) : ("FILA" as const), ...(motivo ? { error: motivo } : {}) };
      }),
    });
  }
  await prisma.campaign.update({ where: { id: campaign.id }, data: { audienceCount: recipients.length, status: "AGENDADA" } });
  return { audienceSize: recipients.length, queued: novos.length - bloqueados, control: 0, skippedDedupe: 0, bloqueados };
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
  // LGPD 02-01: sem base legal declarada nada sai, e a fila fica intacta (sai quando o controlador declarar)
  const semBase = motivoSemBaseLegal(tenant);
  if (semBase) {
    return { processed: 0, remaining: await prisma.messageEvent.count({ where: { campaignId, status: "FILA" } }), results: [], throttled: false, bloqueado: semBase };
  }
  // base vigente no disparo, para campanha criada antes da declaração (as novas já gravam na criação)
  if (!campaign.baseLegal) await prisma.campaign.update({ where: { id: campaignId }, data: { baseLegal: baseLegalVigente(tenant) } });
  const rodape = montarRodape(tenant);
  const providers = await resolveProviders(prisma, campaign.tenantId, campaign.channel);
  // LGPD 06-01: sem provedor do próprio tenant, nada sai e a fila fica intacta (não marca FALHA em massa)
  if (providers.length === 0) {
    return { processed: 0, remaining: await prisma.messageEvent.count({ where: { campaignId, status: "FILA" } }), results: [], throttled: false, bloqueado: semProvedorMotivo(campaign.channel) };
  }

  const alreadySentThisMinute = await sentInLastMinute(prisma, campaign.tenantId);
  const tenantBudget = Math.max(0, tenant.maxMsgsPerMinute - alreadySentThisMinute);
  // Z-API é sessão do WhatsApp Web: lote pequeno (cada envio espera um intervalo) para não estourar o tempo
  // da função nem derrubar o número. O restante sai nas próximas chamadas (a tela repete até acabar).
  const teto = providers[0]?.name === "zapi" ? ZAPI_BATCH_MAX : Infinity;
  const batchSize = Math.min(limit, campaign.throttlePerMin, tenantBudget, teto);

  if (batchSize <= 0) {
    return { processed: 0, remaining: await prisma.messageEvent.count({ where: { campaignId, status: "FILA" } }), results: [], throttled: true };
  }

  const { template: metaTemplate, bloqueado } = await resolveWhatsAppTemplate(prisma, campaign, providers);
  if (bloqueado) {
    return { processed: 0, remaining: await prisma.messageEvent.count({ where: { campaignId, status: "FILA" } }), results: [], throttled: false, bloqueado };
  }

  const header = await prepareHeaderImage(prisma, campaign.tenantId, metaTemplate, providers);
  if (header.bloqueado) {
    return { processed: 0, remaining: await prisma.messageEvent.count({ where: { campaignId, status: "FILA" } }), results: [], throttled: false, bloqueado: header.bloqueado };
  }

  const pending = await prisma.messageEvent.findMany({
    where: { campaignId, status: "FILA" },
    take: batchSize,
    include: { client: true, recipient: true },
  });

  // LGPD 02-03: supressão conferida no ENVIO, em lote (uma passada para todo o lote, não N consultas), para
  // todo evento — com cliente ou só destinatário de lista — pelo telefone (todas as formas do nono dígito) e
  // pelo documento. Cobre quem pediu para parar depois do enfileiramento e o mesmo número em outro cadastro.
  const lote = await suprimidosEmLote(prisma, campaign.tenantId, {
    telefones: pending.map((e) => e.recipient?.telefone ?? e.client?.telefone),
    docHashes: pending.flatMap((e) => [e.client?.cpfHash, e.recipient?.cpfHash]),
  });

  const results = [];
  for (const evt of pending) {
    const block = async (error: string) => {
      await prisma.messageEvent.update({ where: { id: evt.id }, data: { status: "BLOQUEADO", error } });
    };
    const client = evt.client;
    if (!client && !evt.recipient) {
      await block("Destinatário sem cliente");
      continue;
    }
    // LGPD 02-03: o opt-out do destinatário de lista também vale no envio (antes só o do cliente era lido)
    if (evt.recipient?.optOutAt) {
      await block("Destinatário pediu para não receber (opt-out)");
      continue;
    }
    const motivoCliente = motivoBloqueioCliente(client);
    if (motivoCliente) {
      await block(motivoCliente);
      continue;
    }
    const telefoneEnvio = evt.recipient?.telefone ?? client!.telefone;
    if (
      contatoSuprimido(lote, { telefone: telefoneEnvio, cpfHash: client?.cpfHash }) ||
      contatoSuprimido(lote, { telefone: null, cpfHash: evt.recipient?.cpfHash })
    ) {
      const canon = canonicalPhone(telefoneEnvio);
      await block(textoSupressao(canon ? lote.motivos.get(canon) : null));
      continue;
    }
    // Garantia no envio: mensagem já na fila de quem (ainda) não tem limite não sai.
    // (Contato de lista manual que não é cliente da base não tem limite cadastrado: vale a lista.)
    if (client && !(Number(client.limiteTotal) > 0)) {
      await block("Cliente sem limite (comércio credenciado)");
      continue;
    }

    const ctx = evt.recipient ? recipientContext(evt.recipient, client) : templateContext(client!);
    const telefone = telefoneEnvio;
    const templateBody = evt.variant === "B" && campaign.messageTemplateB ? campaign.messageTemplateB : campaign.messageTemplate;
    if (evt.recipient && evt.recipient.limiteDisponivel === null && usesLimiteDisponivel(metaTemplate ? metaTemplate.body : templateBody)) {
      await block("Sem limite disponível na planilha (a mensagem usa essa variável)");
      continue;
    }
    // LGPD 02-05/02-07: texto livre (SMS, Z-API, mock) leva o rodapé do controlador; template da Meta não muda
    const body = metaTemplate ? renderTemplate(templateBody, ctx) : comRodape(renderTemplate(templateBody, ctx), rodape);

    // Template da Meta: os parâmetros saem do cadastro do cliente / da lista (variante B não existe aqui: a Meta aprova um texto só).
    const tplParams = metaTemplate ? templateParams(metaTemplate, ctx) : null;
    const sendResult = await sendWithFailover(
      providers,
      telefone,
      body,
      metaTemplate ? { name: metaTemplate.metaName, language: metaTemplate.language, params: tplParams!, headerImageId: header.imageId, buttonTokens: trackedButtons(metaTemplate).map((b) => ({ index: b.index, token: makeToken("e", evt.id, b.index) })) } : undefined
    );

    // A conversa da inbox passa a mostrar o que foi enviado (quando o cliente responder, quem atende vê a oferta).
    if (metaTemplate && sendResult.status === "SENT" && sendResult.providerMessageId) {
      await recordOutboundTemplateMessage(
        prisma,
        campaign.tenantId,
        { id: client?.id ?? null, telefone, nome: evt.recipient?.nome },
        sendResult.providerMessageId,
        templatePreview(metaTemplate, tplParams!)
      ).catch((e) => console.warn("[campaignQueue] não registrou na inbox:", e.message));
    }

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
    results.push({ clientId: evt.clientId, recipientId: evt.recipientId, status: sendResult.status, provider: sendResult.provider });
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
  if (providers.length === 0) throw new Error(semProvedorMotivo(campaign.channel)); // LGPD 06-01

  const sample = { nome: "Cliente Teste", cidade: "São Paulo", percentual: 42, saldo: brl(850), limite: brl(1500), limite_disponivel: brl(850) };
  const { template: metaTemplate, bloqueado } = await resolveWhatsAppTemplate(prisma, campaign, providers);
  if (bloqueado) throw new Error(bloqueado);
  // LGPD 02-05: o teste mostra o texto como o cliente vai receber (com o rodapé, no texto livre)
  const controlador = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true, controladorNome: true, rodapeOptOut: true } });
  const body = metaTemplate ? renderTemplate(campaign.messageTemplate, sample) : comRodape(renderTemplate(campaign.messageTemplate, sample), montarRodape(controlador ?? {}));
  const params = metaTemplate ? templateParams(metaTemplate, sample) : null;
  const header = await prepareHeaderImage(prisma, tenantId, metaTemplate, providers);
  if (header.bloqueado) throw new Error(header.bloqueado);

  // LGPD 02-03: o envio de teste também não fala com telefone que pediu para parar
  const lote = await suprimidosEmLote(prisma, tenantId, { telefones: phones });
  const results = [];
  for (const phone of phones) {
    if (contatoSuprimido(lote, { telefone: phone })) {
      results.push({ phone, status: "FAILED" as const, provider: "none", error: textoSupressao(lote.motivos.get(canonicalPhone(phone) ?? "")) });
      continue;
    }
    const sendResult = await sendWithFailover(providers, phone, body, metaTemplate ? { name: metaTemplate.metaName, language: metaTemplate.language, params: params!, headerImageId: header.imageId, buttonTokens: trackedButtons(metaTemplate).map((b) => ({ index: b.index, token: makeToken("n", metaTemplate.id, b.index) })) } : undefined);
    results.push({ phone, status: sendResult.status, provider: sendResult.provider, error: sendResult.error });
  }
  return { body, results };
}

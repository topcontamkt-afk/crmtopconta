import express, { Router } from "express";
import { Prisma } from "@prisma/client";
import crypto from "crypto";
import { z } from "zod";
import { prisma } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../middleware/audit";
import { decryptSecret, encryptSecret, isEncryptedPayload } from "../services/crypto";
import { isSmsOptOut, parseSmsWebhook, smsWebhookSecretOk } from "../services/channels/sms";
import { registrarOptOutTelefone } from "../services/privacy";
import { exportTenantSummaryToSheet } from "../services/biExport";
import { env } from "../config/env";
import { withCrossTenantAccess, runWithTenantContextAsync } from "../config/tenantGuard";
import { credentialsOf, encryptCredentials, generateVerifyToken, hint, maskedHint } from "../services/whatsappAccount";
import { WHATSAPP_API_VERSION } from "../services/whatsappMedia";
import { applyTemplateEvent } from "../services/whatsappTemplateSync";
import { parseTemplateEvents, parseWebhookPayload } from "../services/whatsappPayload";
import { nextEventStatus } from "../services/whatsappPayload";
import { applyOutboundStatus } from "../services/whatsappReply";
import { callingChecks } from "../services/whatsappCalling";
import { getOrCacheMessageMedia } from "../services/whatsappMedia";
import { storeInboundMessage } from "../services/whatsappInbox";
import { maybeAutoReply } from "../services/whatsappAutoReply";
import { verifyTwilioSignature, verifyWhatsAppSignature } from "../services/webhookAuth";
import { webhookLimiter } from "../middleware/rateLimit";

const router = Router();

/** ---- Conexão Google Sheets (mapeamento de colunas + agendamento) ---- */
router.use("/sheets", requireAuth);

router.get("/sheets", async (req, res) => {
  const conn = await prisma.sheetConnection.findFirst({ where: { tenantId: req.user!.tenantId } });
  res.json(conn);
});

/**
 * GET /api/integrations/sheets/service-account — expõe só o e-mail da Service Account
 * (não é segredo, é o identificador público que o cliente precisa saber para compartilhar a
 * planilha), para a tela de Integrações guiar o usuário sem ele precisar abrir o JSON da
 * credencial. Nunca retorna a private_key.
 */
router.get("/sheets/service-account", (_req, res) => {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return res.json({ configured: false });
  try {
    const { client_email } = JSON.parse(raw);
    res.json({ configured: true, email: client_email as string });
  } catch {
    res.json({ configured: false, error: "GOOGLE_SERVICE_ACCOUNT_JSON inválido (não é um JSON válido)" });
  }
});

const sheetConnSchema = z.object({
  sheetId: z.string(),
  sheetRange: z.string().default("A1:Z"),
  columnMapping: z.record(z.string()),
  cronSchedule: z.string().default("0 6 * * 1,4"),
});

router.put("/sheets", requireRole("ADMIN"), async (req, res) => {
  const parsed = sheetConnSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: userId } = req.user!;

  const existing = await prisma.sheetConnection.findFirst({ where: { tenantId } });
  const data = { tenantId, ...parsed.data, columnMapping: parsed.data.columnMapping as any };
  const conn = existing
    ? await prisma.sheetConnection.update({ where: { id: existing.id }, data })
    : await prisma.sheetConnection.create({ data });

  await logAudit({ tenantId, userId, action: "CONFIGURE_SHEETS_CONNECTION", target: "SheetConnection", targetId: conn.id });
  res.json(conn);
});

/**
 * POST /api/integrations/sheets/export-now — conector BI leve (Fase 3): dispara sob demanda o
 * mesmo export que roda 1x/dia via Vercel Cron Job, escrevendo o resumo na aba "CRM_Export".
 */
router.post("/sheets/export-now", requireRole("ADMIN", "OPERATOR", "ANALYST"), async (req, res) => {
  const { tenantId, id: userId } = req.user!;
  const result = await exportTenantSummaryToSheet(prisma, tenantId);
  if (result.exported) {
    await logAudit({ tenantId, userId, action: "BI_EXPORT", target: "SheetConnection" });
  }
  res.json(result);
});

/** ---- Configuração de canais (WhatsApp/SMS) ---- */
router.use("/channels", requireAuth);

router.get("/channels", async (req, res) => {
  const configs = await prisma.channelConfig.findMany({
    where: { tenantId: req.user!.tenantId },
    orderBy: [{ channel: "asc" }, { priority: "asc" }],
  });
  // nunca retorna as credenciais (mesmo cifradas) para o frontend; a URL do webhook (com o segredo) só para ADMIN
  const admin = req.user!.role === "ADMIN";
  res.json(configs.map((c) => ({ id: c.id, channel: c.channel, provider: c.provider, priority: c.priority, active: c.active, ...(admin ? { webhookUrl: smsWebhookUrl(c) } : {}) })));
});

/** LGPD 05-05: URL que o provedor de SMS deve chamar (status e respostas do titular); o segredo autentica o canal. */
function smsWebhookUrl(c: { id: string; channel: string; provider: string; webhookSecret: string | null }): string | null {
  if (c.channel !== "SMS" || !c.webhookSecret) return null;
  return `${publicBackend().replace(/\/+$/, "")}/api/integrations/webhooks/sms/${encodeURIComponent(c.provider)}/${c.id}/${c.webhookSecret}`;
}

const channelSchema = z.object({
  channel: z.enum(["WHATSAPP", "SMS"]),
  provider: z.string(),
  credentials: z.record(z.string()),
  // Prioridade de fallback entre múltiplos provedores do mesmo canal (menor = tentado primeiro).
  // Permite, por exemplo, cadastrar Twilio (priority 0) e Zenvia (priority 1) para SMS com failover.
  priority: z.number().int().min(0).default(0),
});

router.put("/channels", requireRole("ADMIN"), async (req, res) => {
  const parsed = channelSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: userId } = req.user!;
  const { channel, provider, credentials, priority } = parsed.data;

  const encrypted = encryptSecret(credentials);
  const atual = await prisma.channelConfig.findFirst({ where: { tenantId, channel, provider }, select: { webhookSecret: true } });

  const config = await prisma.channelConfig.upsert({
    where: { tenantId_channel_provider: { tenantId, channel, provider } },
    // canal antigo sem segredo ganha um (sem ele o webhook do canal recusa tudo — LGPD 05-05)
    update: { credentials: encrypted as any, active: true, priority, ...(atual?.webhookSecret ? {} : { webhookSecret: crypto.randomBytes(16).toString("hex") }) },
    create: {
      tenantId,
      channel,
      provider,
      credentials: encrypted as any,
      priority,
      webhookSecret: crypto.randomBytes(16).toString("hex"),
    },
  });

  await logAudit({ tenantId, userId, action: "CONFIGURE_CHANNEL", target: "ChannelConfig", targetId: config.id, details: { channel, provider, priority } });
  res.json({ id: config.id, channel: config.channel, provider: config.provider, priority: config.priority, active: config.active, webhookUrl: smsWebhookUrl(config) });
});

router.delete("/channels/:id", requireRole("ADMIN"), async (req, res) => {
  const { tenantId, id: userId } = req.user!;
  const config = await prisma.channelConfig.findFirst({ where: { id: req.params.id, tenantId } });
  if (!config) return res.status(404).json({ error: "Configuração não encontrada" });
  await prisma.channelConfig.delete({ where: { id: config.id } });
  await logAudit({ tenantId, userId, action: "DELETE_CHANNEL_CONFIG", target: "ChannelConfig", targetId: config.id });
  res.status(204).send();
});

/** ---- WhatsApp (Meta Cloud API): configuração pela tela de Integrações ---- */
// Credenciais cifradas por conta (WhatsAppAccount); nada disso volta para a tela além das "dicas" (4 últimos
// caracteres). O token de verificação do webhook é gerado aqui e mostrado para colar na Meta.

const publicBackend = () => process.env.PUBLIC_BACKEND_URL || "https://crmtopconta-backend.vercel.app";

function presentWhatsApp(account: any) {
  return {
    account: account
      ? {
          phoneNumberId: account.phoneNumberId,
          wabaId: account.wabaId,
          appId: account.appId,
          displayName: account.displayName,
          displayPhone: account.displayPhone,
          active: account.active,
          accessToken: maskedHint(account.accessTokenHint),
          appSecret: maskedHint(account.appSecretHint),
          hasCredentials: !!account.credentials,
          verifyToken: account.verifyToken,
          lastCheckAt: account.lastCheckAt?.toISOString() ?? null,
          lastCheckOk: account.lastCheckOk,
          lastCheckMessage: account.lastCheckMessage,
        }
      : null,
    webhookUrl: `${publicBackend()}/api/integrations/webhooks/whatsapp`,
    apiVersion: WHATSAPP_API_VERSION,
  };
}

router.get("/whatsapp", requireAuth, async (req, res) => {
  const account = await prisma.whatsAppAccount.findFirst({ where: { tenantId: req.user!.tenantId, provider: "META" }, orderBy: { createdAt: "asc" } });
  res.json(presentWhatsApp(account));
});

const whatsappSchema = z.object({
  phoneNumberId: z.string().trim().regex(/^\d{5,30}$/, "Phone Number ID são só dígitos"),
  wabaId: z.string().trim().regex(/^\d{5,30}$/, "WABA ID são só dígitos"),
  // Opcional: só é preciso para criar templates com imagem no cabeçalho
  appId: z.string().trim().regex(/^\d{5,30}$/, "App ID são só dígitos").optional().or(z.literal("")),
  // Em branco = manter o que já está salvo
  accessToken: z.string().trim().max(1000).optional(),
  appSecret: z.string().trim().max(200).optional(),
});

router.put("/whatsapp", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const parsed = whatsappSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(" ") });
  const { tenantId, id: userId } = req.user!;
  const { phoneNumberId, wabaId } = parsed.data;

  // Cross-tenant de propósito: phoneNumberId é único no banco inteiro (o webhook só conhece esse id).
  const sameNumber = await withCrossTenantAccess(() => prisma.whatsAppAccount.findFirst({ where: { phoneNumberId, provider: "META" } }));
  if (sameNumber && sameNumber.tenantId !== tenantId) return res.status(409).json({ error: "Este número já está conectado a outra conta." });

  const current = await prisma.whatsAppAccount.findFirst({ where: { tenantId, provider: "META" }, orderBy: { createdAt: "asc" } });
  const old = credentialsOf(current && current.credentials ? current : null);
  const hadStored = !!current?.credentials;
  const accessToken = parsed.data.accessToken || (hadStored ? old.accessToken : undefined);
  const appSecret = parsed.data.appSecret || (hadStored ? old.appSecret : undefined);
  if (!accessToken) return res.status(400).json({ error: "Informe o Access Token (permanente)." });
  if (!appSecret) return res.status(400).json({ error: "Informe o App Secret (Configurações do app > Básico)." });

  const data = {
    phoneNumberId,
    wabaId,
    appId: parsed.data.appId === undefined ? current?.appId ?? null : parsed.data.appId || null,
    active: true,
    credentials: encryptCredentials({ accessToken, appSecret }) as any,
    accessTokenHint: hint(accessToken),
    appSecretHint: hint(appSecret),
  };
  const account = current
    ? await prisma.whatsAppAccount.update({ where: { id: current.id }, data: { ...data, verifyToken: current.verifyToken ?? generateVerifyToken(), lastCheckOk: null, lastCheckMessage: null } })
    : await prisma.whatsAppAccount.create({ data: { tenantId, ...data, verifyToken: generateVerifyToken() } });

  await logAudit({ tenantId, userId, action: "CONFIGURE_WHATSAPP", target: "WhatsAppAccount", targetId: account.id, details: { phoneNumberId, wabaId, tokenAlterado: !!parsed.data.accessToken, segredoAlterado: !!parsed.data.appSecret } });
  res.json(presentWhatsApp(account));
});

/** POST /api/integrations/whatsapp/test — valida token + número + WABA na Meta e guarda o resultado. */
router.post("/whatsapp/test", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const { tenantId } = req.user!;
  const account = await prisma.whatsAppAccount.findFirst({ where: { tenantId, provider: "META" }, orderBy: { createdAt: "asc" } });
  const token = credentialsOf(account).accessToken;
  if (!account || !token) return res.status(409).json({ error: "Salve o Phone Number ID, o WABA ID e o Access Token antes de testar." });

  const get = async (path: string) => {
    const r = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
    return j;
  };

  let ok = true;
  const checks: { nome: string; ok: boolean; detalhe: string }[] = [];
  let displayName = account.displayName;
  let displayPhone = account.displayPhone;
  try {
    const n = await get(`${encodeURIComponent(account.phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating,name_status`);
    displayName = n.verified_name ?? displayName;
    displayPhone = n.display_phone_number ?? displayPhone;
    checks.push({ nome: "Número (Phone Number ID)", ok: true, detalhe: `${n.verified_name ?? "sem nome"} · ${n.display_phone_number ?? ""} · qualidade ${n.quality_rating ?? "n/d"}` });
  } catch (e) {
    ok = false;
    checks.push({ nome: "Número (Phone Number ID)", ok: false, detalhe: (e as Error).message });
  }
  if (account.wabaId) {
    try {
      const w = await get(`${encodeURIComponent(account.wabaId)}?fields=name,message_template_namespace`);
      checks.push({ nome: "Conta do WhatsApp Business (WABA)", ok: true, detalhe: w.name ?? "acessível" });
    } catch (e) {
      ok = false;
      checks.push({ nome: "Conta do WhatsApp Business (WABA)", ok: false, detalhe: (e as Error).message });
    }
  }

  const message = checks.map((c) => `${c.ok ? "OK" : "FALHA"}: ${c.nome} — ${c.detalhe}`).join(" | ").slice(0, 500);
  await prisma.whatsAppAccount.update({ where: { id: account.id }, data: { lastCheckAt: new Date(), lastCheckOk: ok, lastCheckMessage: message, displayName, displayPhone } });

  // Pré-requisitos da Calling API: só informativo (não muda "ok" nem o resultado guardado acima).
  let tier: string | undefined, tierError: string | undefined, callingStatus: string | undefined, callingError: string | undefined;
  try {
    tier = (await get(`${encodeURIComponent(account.phoneNumberId)}?fields=messaging_limit_tier`)).messaging_limit_tier;
  } catch (e) {
    tierError = (e as Error).message;
  }
  try {
    callingStatus = (await get(`${encodeURIComponent(account.phoneNumberId)}/settings`))?.calling?.status;
  } catch (e) {
    callingError = (e as Error).message;
  }
  res.json({ ok, checks, ligacoes: callingChecks({ tier, callingStatus, tierError, callingError }) });
});

/** POST /api/integrations/whatsapp/subscribe — inscreve o app na conta (WABA) para a Meta enviar os webhooks. */
router.post("/whatsapp/subscribe", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const { tenantId, id: userId } = req.user!;
  const account = await prisma.whatsAppAccount.findFirst({ where: { tenantId, provider: "META" }, orderBy: { createdAt: "asc" } });
  const token = credentialsOf(account).accessToken;
  if (!account?.wabaId || !token) return res.status(409).json({ error: "Salve o WABA ID e o Access Token antes." });
  try {
    const r = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${encodeURIComponent(account.wabaId)}/subscribed_apps`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: j?.error?.message || `A Meta recusou (HTTP ${r.status}).` });
    await logAudit({ tenantId, userId, action: "SUBSCRIBE_WHATSAPP_WEBHOOK", target: "WhatsAppAccount", targetId: account.id });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: `Não foi possível falar com a Meta: ${(e as Error).message}` });
  }
});

/** DELETE /api/integrations/whatsapp — desconecta: apaga as credenciais e desativa a conta (o histórico de conversas fica). */
router.delete("/whatsapp", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const { tenantId, id: userId } = req.user!;
  const account = await prisma.whatsAppAccount.findFirst({ where: { tenantId, provider: "META" }, orderBy: { createdAt: "asc" } });
  if (!account) return res.status(404).json({ error: "Nenhuma conta conectada." });
  await prisma.whatsAppAccount.update({ where: { id: account.id }, data: { active: false, credentials: Prisma.DbNull, accessTokenHint: null, appSecretHint: null } });
  await logAudit({ tenantId, userId, action: "DISCONNECT_WHATSAPP", target: "WhatsAppAccount", targetId: account.id });
  res.status(204).send();
});

/** ---- Webhooks públicos de status (WhatsApp / SMS) ---- */
// Sem requireAuth (não há sessão de usuário aqui): a origem é validada por assinatura própria de
// cada provedor, verificada abaixo em cada handler POST — X-Hub-Signature-256 (WhatsApp/Meta,
// HMAC-SHA256 sobre o corpo bruto com WHATSAPP_APP_SECRET) e X-Twilio-Signature (SMS/Twilio,
// HMAC-SHA1 sobre a URL + params com TWILIO_AUTH_TOKEN). A verificação do WhatsApp é condicional:
// enquanto WHATSAPP_APP_SECRET não estiver configurado (segredo novo, pode não ter sido
// provisionado ainda em produção), o handler aceita a requisição sem checar a assinatura, mas
// registra um warning a cada chamada — ver verifyWhatsAppSignature/verifyTwilioSignature em
// services/webhookAuth.ts. Idempotentes por providerMsgId.

router.get("/webhooks/whatsapp", async (req, res) => {
  // Desafio da Meta (hub.challenge) ao cadastrar o webhook: vale o token de verificação gerado para
  // alguma conta (tela de Integrações) ou, como reserva, o da variável de ambiente.
  const token = typeof req.query["hub.verify_token"] === "string" ? req.query["hub.verify_token"] : "";
  if (req.query["hub.mode"] === "subscribe" && token) {
    const envToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    // Cross-tenant de propósito: o desafio da Meta não traz tenant; o token é que identifica a conta.
    const account = await withCrossTenantAccess(() => prisma.whatsAppAccount.findFirst({ where: { verifyToken: token, provider: "META" } }));
    if (account || (envToken && token === envToken)) return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

/** Conta (e tenant) a que o webhook se refere: pelo phone_number_id das mensagens ou pelo WABA ID da entrada. */
async function accountForPayload(body: any) {
  const ids = new Set<string>();
  for (const entry of body?.entry ?? []) {
    if (entry?.id) ids.add(String(entry.id));
    for (const change of entry?.changes ?? []) {
      const p = change?.value?.metadata?.phone_number_id;
      if (p) ids.add(String(p));
    }
  }
  if (ids.size === 0) return null;
  const list = [...ids];
  // Cross-tenant de propósito (webhook público): é por estes ids que se descobre o tenant.
  return withCrossTenantAccess(() =>
    prisma.whatsAppAccount.findFirst({ where: { active: true, provider: "META", OR: [{ phoneNumberId: { in: list } }, { wabaId: { in: list } }] } })
  );
}

router.post("/webhooks/whatsapp", webhookLimiter, async (req, res) => {
  const signature = req.headers["x-hub-signature-256"] as string | undefined;

  // O segredo do app é da conta configurada em Integrações (reserva: variável de ambiente). Ele
  // precisa ser conhecido ANTES de confiar no corpo, então a conta é localizada só para ler o segredo.
  const hintAccount = await accountForPayload(req.body).catch(() => null);
  const appSecret = credentialsOf(hintAccount).appSecret;

  if (appSecret) {
    if (!req.rawBody || !verifyWhatsAppSignature(req.rawBody, signature, appSecret)) {
      return res.sendStatus(401);
    }
  } else {
    console.warn(
      "[webhooks/whatsapp] sem App Secret (Integrações > WhatsApp) — a assinatura X-Hub-Signature-256 não pôde ser " +
        "verificada: mensagens recebidas, status de respostas e templates serão ignorados."
    );
  }

  try {
    const entries = req.body?.entry || [];
    // Status das mensagens de CAMPANHA (enviado/entregue/lido/falhou). Só com assinatura verificada.
    if (appSecret) {
      for (const entry of entries) {
        for (const change of entry.changes || []) {
          for (const status of change.value?.statuses || []) {
            await applyStatusUpdate(status.id, status.status, status.timestamp, status.errors?.[0] ? `${status.errors[0].code ?? ""} ${status.errors[0].title ?? status.errors[0].message ?? ""}`.trim() : null);
          }
        }
      }
    }

    // Mensagens RECEBIDAS dos clientes (inbox). Só são gravadas com a assinatura verificada: sem o
    // segredo qualquer um poderia injetar conversas falsas e disparar opt-outs.
    const { messages, statuses } = parseWebhookPayload(req.body);
    if (appSecret) {
      for (const m of messages) {
        try {
          const account = await withCrossTenantAccess(() =>
            prisma.whatsAppAccount.findFirst({ where: { phoneNumberId: m.phoneNumberId, active: true, provider: "META" } })
          );
          if (!account) {
            console.warn(`[webhooks/whatsapp] phone_number_id ${m.phoneNumberId} sem conta cadastrada — mensagem ignorada`);
            continue;
          }
          const token = credentialsOf(account).accessToken;
          await runWithTenantContextAsync(account.tenantId, async () => {
            const r = await storeInboundMessage(prisma, account.tenantId, account.id, m);
            // Guarda a mídia já agora (a Meta só a mantém por tempo limitado). Se falhar, a tela
            // tenta de novo na primeira visualização — nunca derruba o recebimento da mensagem.
            if (r.stored && r.messageId && m.mediaId && token) {
              await getOrCacheMessageMedia(prisma, account.tenantId, { id: r.messageId, mediaId: m.mediaId }, token).catch((e) =>
                console.warn(`[webhooks/whatsapp] mídia ${m.mediaId} não guardada agora: ${e.message}`)
              );
            }
            // Canal só de avisos: manda o cliente ao suporte (uma vez por conversa a cada poucas horas).
            await maybeAutoReply(prisma, account.tenantId, account, r);
          });
        } catch (e) {
          console.error("[webhooks/whatsapp] falha ao gravar mensagem recebida:", e);
        }
      }
    }

    // Status de entrega das respostas enviadas pela inbox (enviado/entregue/lido/falhou).
    if (appSecret && statuses.length > 0) {
      for (const st of statuses) {
        try {
          const account = await withCrossTenantAccess(() =>
            prisma.whatsAppAccount.findFirst({ where: { phoneNumberId: st.phoneNumberId, active: true, provider: "META" } })
          );
          if (!account) continue;
          await runWithTenantContextAsync(account.tenantId, () => applyOutboundStatus(prisma, account.tenantId, st));
        } catch (e) {
          console.error("[webhooks/whatsapp] falha ao atualizar status de resposta:", e);
        }
      }
    }

    // Aprovação/reprovação/qualidade dos templates (status em tempo real). Só com assinatura válida.
    if (appSecret) {
      for (const ev of parseTemplateEvents(req.body)) {
        try {
          const account = await withCrossTenantAccess(() =>
            prisma.whatsAppAccount.findFirst({ where: { wabaId: ev.wabaId, active: true, provider: "META" } })
          );
          if (!account) continue;
          await runWithTenantContextAsync(account.tenantId, () => applyTemplateEvent(prisma, account.tenantId, ev));
        } catch (e) {
          console.error("[webhooks/whatsapp] falha ao atualizar template:", e);
        }
      }
    }
    res.sendStatus(200);
  } catch (e) {
    res.sendStatus(200); // sempre 200 para não gerar re-tentativas em loop do provedor
  }
});

/**
 * ---- Webhook de SMS (status de entrega e mensagem RECEBIDA do titular) ----
 *
 * LGPD 05-05: nenhuma requisição é aceita sem autenticação válida, para TODO provedor:
 *  - rota por canal `/webhooks/sms/:provider/:configId/:secret` (ou o segredo no cabeçalho `X-Webhook-Secret`):
 *    o segredo é o `ChannelConfig.webhookSecret` do tenant, comparado em tempo constante; na Twilio a assinatura
 *    X-Twilio-Signature também é conferida, com o Auth Token DAQUELE canal. O tenant sai do canal, e status e
 *    opt-out só mexem nele.
 *  - rota antiga `/webhooks/sms/:provider`: só Twilio com assinatura do token do ambiente (TWILIO_AUTH_TOKEN), para
 *    o número global; qualquer outro provedor recebe 401 (antes a Zenvia passava sem verificação nenhuma).
 * LGPD 02-04: resposta "PARAR/SAIR/STOP..." do titular por SMS grava a supressão do telefone (canal SMS) e o
 * opt-out de todos os cadastros com o número, com auditoria OPT_OUT_SMS.
 */
const smsParsers = [webhookLimiter, express.urlencoded({ extended: false })];

/** URL pública exatamente como a Twilio a assinou (atrás do proxy da Vercel: X-Forwarded-*). */
function publicUrlOf(req: express.Request): string {
  const forwardedProto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0];
  const forwardedHost = req.headers["x-forwarded-host"] as string | undefined;
  const proto = forwardedProto || req.protocol;
  const host = forwardedHost || req.get("host") || "";
  return `${proto}://${host}${req.originalUrl}`;
}

function twilioSignatureOk(req: express.Request, authToken: string | undefined): boolean {
  if (!authToken) return false;
  return verifyTwilioSignature(publicUrlOf(req), req.body as Record<string, string>, req.headers["x-twilio-signature"] as string | undefined, authToken);
}

/** Aplica os eventos já autenticados. `tenantId` nulo = rota antiga sem tenant definido (só status, como antes). */
async function processSmsWebhook(req: express.Request, res: express.Response, provider: string, tenantId: string | null) {
  let inbound = false;
  for (const ev of parseSmsWebhook(provider, req.body)) {
    try {
      if (ev.kind === "status") {
        await applyStatusUpdate(ev.providerMsgId, ev.status, undefined, null, tenantId);
        continue;
      }
      inbound = true;
      if (!isSmsOptOut(ev.body)) continue; // só o pedido de parar é tratado; o resto do texto não é guardado
      if (!tenantId) {
        console.warn("[webhooks/sms] pedido de descadastro por SMS sem tenant definido (rota antiga sem PLATFORM_DEFAULT_TENANT_ID): use a URL do canal.");
        continue;
      }
      await runWithTenantContextAsync(tenantId, async () => {
        const r = await registrarOptOutTelefone(prisma, tenantId, { telefone: ev.from, canal: "SMS", origem: `sms_webhook:${provider}` });
        await logAudit({ tenantId, action: "OPT_OUT_SMS", target: "Telefone", details: { telefone: r.telefoneMasked, clientIds: r.clientIds, provider, providerMsgId: ev.providerMsgId } });
      });
    } catch (e) {
      console.error("[webhooks/sms] falha ao processar evento:", e);
    }
  }
  // Mensagem recebida da Twilio: TwiML vazio (nenhuma resposta automática por SMS)
  if (inbound && provider === "twilio") return res.type("text/xml").send("<Response></Response>");
  res.sendStatus(200);
}

async function smsWebhookPorCanal(req: express.Request, res: express.Response) {
  const { provider, configId } = req.params;
  const secret = req.params.secret || (req.headers["x-webhook-secret"] as string | undefined);
  // Cross-tenant de propósito (webhook público): o canal é o que identifica o tenant.
  const config = await withCrossTenantAccess(() => prisma.channelConfig.findFirst({ where: { id: configId, channel: "SMS", provider } })).catch(() => null);
  if (!config || !smsWebhookSecretOk(secret, config.webhookSecret)) return res.sendStatus(401);
  if (provider === "twilio") {
    let authToken: string | undefined;
    try {
      const payload = config.credentials as any;
      authToken = (isEncryptedPayload(payload) ? decryptSecret(payload) : payload)?.authToken;
    } catch {
      authToken = undefined;
    }
    if (!twilioSignatureOk(req, authToken)) return res.sendStatus(401);
  }
  return processSmsWebhook(req, res, provider, config.tenantId);
}

router.post("/webhooks/sms/:provider/:configId/:secret", ...smsParsers, smsWebhookPorCanal);
router.post("/webhooks/sms/:provider/:configId", ...smsParsers, smsWebhookPorCanal);

// Rota antiga (número global do ambiente): só Twilio, só com assinatura válida.
router.post("/webhooks/sms/:provider", ...smsParsers, async (req, res) => {
  if (req.params.provider !== "twilio") return res.sendStatus(401); // LGPD 05-05: provedor sem verificação não entra
  const authToken = env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.warn("[webhooks/sms/twilio] TWILIO_AUTH_TOKEN não configurado — não é possível verificar a assinatura X-Twilio-Signature. Requisição rejeitada.");
    return res.sendStatus(401);
  }
  if (!twilioSignatureOk(req, authToken)) return res.sendStatus(401);
  // O número global só pode ter sido usado pelo tenant dono dele (LGPD 06-01); sem ele, status sem tenant (como antes).
  const dono = process.env.PLATFORM_DEFAULT_TENANT_ID?.trim() || null;
  return processSmsWebhook(req, res, "twilio", dono);
});

async function applyStatusUpdate(providerMsgId: string, providerStatus: string, timestamp?: string, errorText?: string | null, tenantId?: string | null) {
  // Cross-tenant de propósito: o webhook é público e a única chave é o id da mensagem na Meta (único).
  // Sem isso a RLS (MessageEvent só enxerga o tenant da sessão) escondia a linha e o status nunca atualizava.
  // LGPD 05-05: quando o webhook identificou o tenant (canal autenticado), só mexe nas mensagens dele.
  await withCrossTenantAccess(async () => {
    const event = await prisma.messageEvent.findFirst({ where: { providerMsgId, ...(tenantId ? { campaign: { tenantId } } : {}) } });
    if (!event) return; // idempotência: evento desconhecido/duplicado é ignorado silenciosamente

    const next = nextEventStatus(event.status, providerStatus);
    if (!next) return;
    const quando = timestamp && Number.isFinite(Number(timestamp)) ? new Date(Number(timestamp) * 1000) : new Date();

    await prisma.messageEvent.update({
      where: { id: event.id },
      data: {
        status: next as any,
        deliveredAt: (next === "ENTREGUE" || next === "LIDO") && !event.deliveredAt ? quando : event.deliveredAt,
        respondedAt: next === "RESPONDIDO" ? quando : event.respondedAt,
        error: next === "FALHA" ? errorText ?? event.error ?? "Falha na entrega" : event.error,
      },
    });
  });
}

export default router;

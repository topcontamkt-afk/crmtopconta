import { Router } from "express";
import crypto from "crypto";
import { z } from "zod";
import { prisma } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../middleware/audit";
import { encryptSecret } from "../services/crypto";
import { exportTenantSummaryToSheet } from "../services/biExport";

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
  // nunca retorna as credenciais (mesmo cifradas) para o frontend
  res.json(configs.map((c) => ({ id: c.id, channel: c.channel, provider: c.provider, priority: c.priority, active: c.active })));
});

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

  const config = await prisma.channelConfig.upsert({
    where: { tenantId_channel_provider: { tenantId, channel, provider } },
    update: { credentials: encrypted as any, active: true, priority },
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
  res.json({ id: config.id, channel: config.channel, provider: config.provider, priority: config.priority, active: config.active });
});

router.delete("/channels/:id", requireRole("ADMIN"), async (req, res) => {
  const { tenantId, id: userId } = req.user!;
  const config = await prisma.channelConfig.findFirst({ where: { id: req.params.id, tenantId } });
  if (!config) return res.status(404).json({ error: "Configuração não encontrada" });
  await prisma.channelConfig.delete({ where: { id: config.id } });
  await logAudit({ tenantId, userId, action: "DELETE_CHANNEL_CONFIG", target: "ChannelConfig", targetId: config.id });
  res.status(204).send();
});

/** ---- Webhooks públicos de status (WhatsApp / SMS) ---- */
// Sem requireAuth: validados por assinatura/token do provedor. Idempotentes por providerMsgId.

router.get("/webhooks/whatsapp", (req, res) => {
  // Verificação de challenge do Meta (hub.challenge) na configuração do webhook
  const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === verifyToken) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

router.post("/webhooks/whatsapp", async (req, res) => {
  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        for (const status of change.value?.statuses || []) {
          await applyStatusUpdate(status.id, status.status, status.timestamp);
        }
      }
    }
    res.sendStatus(200);
  } catch (e) {
    res.sendStatus(200); // sempre 200 para não gerar re-tentativas em loop do provedor
  }
});

router.post("/webhooks/sms/:provider", async (req, res) => {
  // Formato varia por provedor (Twilio/Zenvia); normaliza para {providerMsgId, status}
  const { MessageSid, MessageStatus, sid, status } = req.body;
  const providerMsgId = MessageSid || sid;
  const providerStatus = MessageStatus || status;
  if (providerMsgId) await applyStatusUpdate(providerMsgId, providerStatus);
  res.sendStatus(200);
});

async function applyStatusUpdate(providerMsgId: string, providerStatus: string, timestamp?: string) {
  const event = await prisma.messageEvent.findFirst({ where: { providerMsgId } });
  if (!event) return; // idempotência: evento desconhecido/duplicado é ignorado silenciosamente

  const map: Record<string, string> = {
    sent: "ENVIADO",
    delivered: "ENTREGUE",
    read: "LIDO",
    replied: "RESPONDIDO",
    failed: "FALHA",
    undelivered: "FALHA",
  };
  const status = map[providerStatus?.toLowerCase()] || event.status;

  await prisma.messageEvent.update({
    where: { id: event.id },
    data: {
      status: status as any,
      deliveredAt: status === "ENTREGUE" ? new Date() : event.deliveredAt,
      respondedAt: status === "RESPONDIDO" ? new Date() : event.respondedAt,
    },
  });
}

export default router;

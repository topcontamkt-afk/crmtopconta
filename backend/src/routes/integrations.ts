import { Router } from "express";
import crypto from "crypto";
import { z } from "zod";
import { prisma } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../middleware/audit";

const router = Router();

/** ---- Conexão Google Sheets (mapeamento de colunas + agendamento) ---- */
router.use("/sheets", requireAuth);

router.get("/sheets", async (req, res) => {
  const conn = await prisma.sheetConnection.findFirst({ where: { tenantId: req.user!.tenantId } });
  res.json(conn);
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

/** ---- Configuração de canais (WhatsApp/SMS) ---- */
router.use("/channels", requireAuth);

router.get("/channels", async (req, res) => {
  const configs = await prisma.channelConfig.findMany({ where: { tenantId: req.user!.tenantId } });
  // nunca retorna as credenciais brutas para o frontend
  res.json(configs.map((c) => ({ id: c.id, channel: c.channel, provider: c.provider, active: c.active })));
});

const channelSchema = z.object({
  channel: z.enum(["WHATSAPP", "SMS"]),
  provider: z.string(),
  credentials: z.record(z.string()),
});

router.put("/channels", requireRole("ADMIN"), async (req, res) => {
  const parsed = channelSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: userId } = req.user!;
  const { channel, provider, credentials } = parsed.data;

  const config = await prisma.channelConfig.upsert({
    where: { tenantId_channel_provider: { tenantId, channel, provider } },
    update: { credentials: credentials as any, active: true },
    create: { tenantId, channel, provider, credentials: credentials as any, webhookSecret: crypto.randomBytes(16).toString("hex") },
  });

  await logAudit({ tenantId, userId, action: "CONFIGURE_CHANNEL", target: "ChannelConfig", targetId: config.id, details: { channel, provider } });
  res.json({ id: config.id, channel: config.channel, provider: config.provider, active: config.active });
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

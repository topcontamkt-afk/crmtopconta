import { Router } from "express";
import { prisma } from "../config/db";
import { runWithTenantContextAsync, withCrossTenantAccess } from "../config/tenantGuard";
import { webhookLimiter } from "../middleware/rateLimit";
import { storeInboundMessage } from "../services/whatsappInbox";
import { applyOutboundStatus } from "../services/whatsappReply";
import { instanceIdOf, parseZapiWebhook, zapiStatusToOurs } from "../services/zapi";
import { downloadZapiMedia } from "../services/zapiMedia";

/**
 * Webhook PÚBLICO da Z-API: POST /api/integrations/webhooks/zapi/:secret. A Z-API não assina o corpo, então o
 * segredo vai na URL (`WhatsAppAccount.verifyToken`, único e aleatório) e o `instanceId` do corpo tem que bater
 * com o da conta. Recebe mensagens (vão para a mesma Inbox, ligadas ao cliente pelo telefone, com opt-out
 * PARAR/SAIR) e status de entrega das respostas. Sempre responde 200 rápido para a Z-API não reenviar.
 */
const router = Router();

router.post("/:secret", webhookLimiter, async (req, res) => {
  const secret = String(req.params.secret ?? "");
  const account = secret.length >= 16
    ? await withCrossTenantAccess(() => prisma.whatsAppAccount.findFirst({ where: { provider: "ZAPI", verifyToken: secret, active: true } }))
    : null;
  if (!account) return res.status(404).json({ error: "Webhook não encontrado" });

  const event = parseZapiWebhook(req.body, instanceIdOf(account.phoneNumberId));
  if (event.kind === "ignore") return res.json({ ok: true, ignorado: event.motivo });

  try {
    await runWithTenantContextAsync(account.tenantId, async () => {
      if (event.kind === "status") {
        const status = zapiStatusToOurs(event.status);
        if (!status) return;
        for (const id of event.ids) await applyOutboundStatus(prisma, account.tenantId, { wamid: id, status, errorText: null });
        return;
      }
      const { mediaUrl, ...message } = event.message;
      const r = await storeInboundMessage(prisma, account.tenantId, account.id, message);
      // Guarda o arquivo agora (o link da Z-API vale ~30 dias). Melhor esforço: nunca derruba o recebimento.
      if (r.stored && r.messageId && mediaUrl) {
        const file = await downloadZapiMedia(mediaUrl, message.mediaMime).catch((e) => {
          console.warn(`[webhooks/zapi] mídia não guardada: ${(e as Error).message}`);
          return null;
        });
        if (file) {
          await prisma.waMediaBlob.create({ data: { tenantId: account.tenantId, messageId: r.messageId, mime: file.mime, size: file.data.length, data: new Uint8Array(file.data) } }).catch(() => undefined);
        }
      }
    });
  } catch (e) {
    console.error("[webhooks/zapi] falha ao gravar:", e);
  }
  res.json({ ok: true });
});

export default router;

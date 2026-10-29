import { Router } from "express";
import { prisma } from "../config/db";
import { withCrossTenantAccess } from "../config/tenantGuard";
import { rateLimit } from "../middleware/rateLimit";
import { isBotUserAgent, parseToken, trackedButtons } from "../services/trackedLinks";

/**
 * GET /r/:token — redirecionador dos botões de link rastreados. PÚBLICO de propósito (quem toca no
 * botão não está logado): o código é assinado (HMAC), então não dá para adivinhar o de outra mensagem,
 * e o destino vem sempre do template cadastrado por nós (não existe parâmetro de URL de destino →
 * não é um redirecionador aberto). Cross-tenant de propósito: o código só carrega o id da mensagem.
 */
const router = Router();

const limiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });

function fallback(res: any) {
  const url = process.env.LINK_FALLBACK_URL;
  if (url && /^https:\/\//.test(url)) return res.redirect(302, url);
  return res.status(404).type("text/plain").send("Link inválido ou expirado.");
}

router.get("/:token", limiter, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");
  const t = parseToken(req.params.token);
  if (!t) return fallback(res);

  try {
    const found = await withCrossTenantAccess(async () => {
      if (t.kind === "e") {
        const ev = await prisma.messageEvent.findUnique({
          where: { id: t.id },
          select: { id: true, campaign: { select: { template: { select: { quickReplies: true, buttons: true } } } } },
        });
        return ev ? { template: ev.campaign.template, eventId: ev.id } : null;
      }
      const template = await prisma.messageTemplate.findUnique({ where: { id: t.id }, select: { quickReplies: true, buttons: true } });
      return template ? { template, eventId: null as string | null } : null;
    });
    const destino = found?.template ? trackedButtons(found.template).find((b) => b.index === t.buttonIndex)?.url : undefined;
    if (!found || !destino) return fallback(res);

    // Só clique de gente: prévia de link do WhatsApp, antivírus e robôs não contam.
    if (found.eventId && req.method === "GET" && !isBotUserAgent(req.get("user-agent"))) {
      const eventId = found.eventId;
      await withCrossTenantAccess(async () => {
        const atual = await prisma.messageEvent.findUnique({ where: { id: eventId }, select: { clickedAt: true } });
        await prisma.messageEvent.update({ where: { id: eventId }, data: { clickCount: { increment: 1 }, ...(atual?.clickedAt ? {} : { clickedAt: new Date() }) } });
      }).catch((e) => console.warn("[r] não registrou o clique:", e.message));
    }
    return res.redirect(302, destino);
  } catch (e: any) {
    console.error("[r] erro no redirecionamento:", e);
    return fallback(res);
  }
});

export default router;

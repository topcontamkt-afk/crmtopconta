import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/db";
import { withCrossTenantAccess } from "../config/tenantGuard";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../middleware/audit";
import { maskPhone } from "../services/masking";
import { classificarPerfil } from "../services/rendaPerfil";
import { getOrCacheMessageMedia, isInlineSafeMime, MediaError, MEDIA_MAX_BYTES } from "../services/whatsappMedia";
import { sendReply } from "../services/whatsappReply";
import { SendError, OUTBOUND_MAX_BYTES } from "../services/whatsappSend";
import { janelaAte } from "../services/whatsappPayload";

/**
 * Inbox do WhatsApp (Fase 1): lista de conversas e histórico de mensagens recebidas. Leitura e
 * "marcar como lida" — o envio de respostas é a Fase 3. Telefones aparecem mascarados (LGPD).
 */
const router = Router();
router.use(requireAuth);

const present = (v: string | undefined | null) => !!v && v.trim().length > 0;

/** GET /api/inbox/status — a conexão com a Meta está pronta? (só indicadores, nunca os segredos) */
router.get("/status", async (req, res) => {
  const { tenantId } = req.user!;
  const account = await prisma.whatsAppAccount.findFirst({ where: { tenantId }, orderBy: { createdAt: "asc" } });
  const base = process.env.PUBLIC_BACKEND_URL || "https://crmtopconta-backend.vercel.app";
  res.json({
    account: account
      ? { id: account.id, phoneNumberId: account.phoneNumberId, wabaId: account.wabaId, displayName: account.displayName, displayPhone: account.displayPhone, active: account.active }
      : null,
    webhookUrl: `${base}/api/integrations/webhooks/whatsapp`,
    config: {
      appSecret: present(process.env.WHATSAPP_APP_SECRET),
      verifyToken: present(process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN),
      accessToken: present(process.env.WHATSAPP_ACCESS_TOKEN),
    },
  });
});

const accountSchema = z.object({
  phoneNumberId: z.string().regex(/^\d{5,30}$/, "Phone Number ID são só dígitos"),
  wabaId: z.string().regex(/^\d{5,30}$/).optional().or(z.literal("").transform(() => undefined)),
  displayName: z.string().max(120).optional(),
  displayPhone: z.string().max(40).optional(),
});

/** PUT /api/inbox/account — liga um número da Meta (Phone Number ID) a este tenant. */
router.put("/account", requireRole("ADMIN"), async (req, res) => {
  const parsed = accountSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: userId } = req.user!;
  const { phoneNumberId, wabaId, displayName, displayPhone } = parsed.data;

  // Cross-tenant de propósito: phoneNumberId é único no banco inteiro (o webhook da Meta só
  // conhece esse id), então é preciso saber se OUTRO tenant já o registrou.
  const existing = await withCrossTenantAccess(() => prisma.whatsAppAccount.findFirst({ where: { phoneNumberId } }));
  if (existing && existing.tenantId !== tenantId) {
    return res.status(409).json({ error: "Este número já está conectado a outra conta." });
  }

  const data = { wabaId: wabaId ?? null, displayName: displayName ?? null, displayPhone: displayPhone ?? null, active: true };
  const account = existing
    ? await prisma.whatsAppAccount.update({ where: { id: existing.id }, data })
    : await prisma.whatsAppAccount.create({ data: { tenantId, phoneNumberId, ...data } });

  await logAudit({ tenantId, userId, action: "CONFIGURE_WHATSAPP_ACCOUNT", target: "WhatsAppAccount", targetId: account.id, details: { phoneNumberId } });
  res.json({ id: account.id, phoneNumberId: account.phoneNumberId });
});

const listQuery = z.object({
  filtro: z.enum(["todas", "nao_lidas", "janela_aberta", "sem_cliente"]).default("todas"),
  busca: z.string().max(80).optional(),
  limite: z.coerce.number().int().min(1).max(100).default(50),
});

/** GET /api/inbox/conversations */
router.get("/conversations", async (req, res) => {
  const q = listQuery.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: "Parâmetros inválidos" });
  const { tenantId } = req.user!;
  const { filtro, busca, limite } = q.data;

  const where: any = { tenantId, status: "ABERTA" };
  if (filtro === "nao_lidas") where.unreadCount = { gt: 0 };
  if (filtro === "janela_aberta") where.lastInboundAt = { gte: new Date(Date.now() - 24 * 3600_000) };
  if (filtro === "sem_cliente") where.clientId = null;
  if (busca?.trim()) {
    const t = busca.trim();
    where.OR = [
      { contactName: { contains: t, mode: "insensitive" } },
      { client: { is: { nome: { contains: t, mode: "insensitive" } } } },
      ...(/\d{4,}/.test(t) ? [{ waId: { contains: t.replace(/\D/g, "") } }] : []),
    ];
  }

  const [rows, naoLidas] = await Promise.all([
    prisma.conversation.findMany({
      where,
      orderBy: { lastMessageAt: "desc" },
      take: limite,
      include: { client: { select: { id: true, nome: true, cidade: true } } },
    }),
    prisma.conversation.count({ where: { tenantId, status: "ABERTA", unreadCount: { gt: 0 } } }),
  ]);

  const agora = Date.now();
  res.json({
    naoLidas,
    conversas: rows.map((c) => {
      const ate = janelaAte(c.lastInboundAt);
      return {
        id: c.id,
        nome: c.client?.nome ?? c.contactName ?? "Contato sem cadastro",
        cidade: c.client?.cidade ?? null,
        clienteId: c.clientId,
        telefone: maskPhone(c.waId),
        preview: c.lastPreview,
        ultimaMensagemEm: c.lastMessageAt.toISOString(),
        naoLidas: c.unreadCount,
        janelaAberta: !!ate && ate.getTime() > agora,
        janelaAte: ate?.toISOString() ?? null,
      };
    }),
  });
});

const msgsQuery = z.object({ antes: z.string().datetime().optional(), limite: z.coerce.number().int().min(1).max(200).default(100) });

/** GET /api/inbox/conversations/:id/messages — mais antigas primeiro; `antes` pagina para trás. */
router.get("/conversations/:id/messages", async (req, res) => {
  const q = msgsQuery.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: "Parâmetros inválidos" });
  const { tenantId } = req.user!;
  const conversa = await prisma.conversation.findFirst({
    where: { id: req.params.id, tenantId },
    include: { client: { select: { id: true, nome: true, cidade: true, limiteTotal: true, saldoDisponivel: true, faixaUso: true, autorizacaoComunicacao: true, optOutAt: true } } },
  });
  if (!conversa) return res.status(404).json({ error: "Conversa não encontrada" });

  const mensagens = await prisma.waMessage.findMany({
    where: { tenantId, conversationId: conversa.id, ...(q.data.antes ? { timestamp: { lt: new Date(q.data.antes) } } : {}) },
    orderBy: { timestamp: "desc" },
    take: q.data.limite,
  });
  mensagens.reverse();

  const ate = janelaAte(conversa.lastInboundAt);
  const c = conversa.client;
  res.json({
    conversa: {
      id: conversa.id,
      nome: c?.nome ?? conversa.contactName ?? "Contato sem cadastro",
      telefone: maskPhone(conversa.waId),
      janelaAberta: !!ate && ate.getTime() > Date.now(),
      janelaAte: ate?.toISOString() ?? null,
      naoLidas: conversa.unreadCount,
    },
    cliente: c
      ? {
          id: c.id,
          nome: c.nome,
          cidade: c.cidade,
          perfil: classificarPerfil(c.limiteTotal),
          limiteTotal: Number(c.limiteTotal),
          saldoDisponivel: Number(c.saldoDisponivel),
          faixaUso: c.faixaUso,
          podeReceberCampanha: c.autorizacaoComunicacao && !c.optOutAt,
          optOutEm: c.optOutAt?.toISOString() ?? null,
        }
      : null,
    mensagens: mensagens.map((m) => ({
      id: m.id,
      direcao: m.direction,
      tipo: m.type,
      texto: m.body,
      midia: m.mediaId ? { mime: m.mediaMime, nomeArquivo: m.mediaFilename } : null,
      status: m.status,
      erro: m.errorText,
      em: m.timestamp.toISOString(),
    })),
    temMais: mensagens.length === q.data.limite,
  });
});

const replySchema = z.discriminatedUnion("tipo", [
  z.object({ tipo: z.literal("text"), texto: z.string().min(1).max(4096) }),
  z.object({
    tipo: z.literal("arquivo"),
    nome: z.string().min(1).max(200),
    mime: z.string().min(3).max(100),
    base64: z.string().min(4).max(Math.ceil((OUTBOUND_MAX_BYTES * 4) / 3) + 64),
    legenda: z.string().max(1024).optional(),
  }),
]);

const presentMessage = (m: any) => ({
  id: m.id,
  direcao: m.direction,
  tipo: m.type,
  texto: m.body,
  midia: m.mediaId ? { mime: m.mediaMime, nomeArquivo: m.mediaFilename } : null,
  status: m.status,
  erro: m.errorText,
  em: m.timestamp.toISOString(),
});

/**
 * POST /api/inbox/conversations/:id/messages — responde ao cliente (texto ou arquivo). Só dentro da
 * janela de 24 horas; fora dela a resposta é um template (Fase 4). O arquivo vai em base64 no JSON
 * (limite de 3 MB por causa do teto de ~4,5 MB por requisição da Vercel).
 */
router.post("/conversations/:id/messages", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const parsed = replySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Mensagem inválida", codigo: "TIPO_INVALIDO" });
  const { tenantId, id: userId } = req.user!;
  const b = parsed.data;
  try {
    const message = await sendReply(
      prisma,
      tenantId,
      userId,
      req.params.id,
      b.tipo === "text"
        ? { tipo: "text", texto: b.texto }
        : { tipo: "arquivo", nome: b.nome, mime: b.mime, data: Buffer.from(b.base64, "base64"), legenda: b.legenda }
    );
    res.status(201).json(presentMessage(message));
  } catch (e) {
    if (e instanceof SendError) {
      const status = { NAO_ENCONTRADA: 404, JANELA_FECHADA: 409, SEM_TOKEN: 503, TIPO_INVALIDO: 400, MUITO_GRANDE: 413, META: 502 }[e.code];
      return res.status(status).json({ error: e.message, codigo: e.code, metaCodigo: e.metaCode });
    }
    throw e;
  }
});

/** POST /api/inbox/conversations/:id/read */
router.post("/conversations/:id/read", requireRole("ADMIN", "OPERATOR", "ANALYST"), async (req, res) => {
  const { tenantId } = req.user!;
  const conversa = await prisma.conversation.findFirst({ where: { id: req.params.id, tenantId }, select: { id: true } });
  if (!conversa) return res.status(404).json({ error: "Conversa não encontrada" });
  await prisma.conversation.update({ where: { id: conversa.id }, data: { unreadCount: 0 } });
  res.json({ ok: true });
});

/**
 * GET /api/inbox/media/:messageId — o arquivo de uma mensagem (imagem, áudio, PDF...). Autenticado:
 * o front busca com o token e mostra por URL local. Só tipos seguros abrem no navegador; o resto
 * baixa. Sempre com `nosniff` e CSP restritiva, porque o conteúdo vem de terceiros.
 */
router.get("/media/:messageId", async (req, res) => {
  const { tenantId } = req.user!;
  const msg = await prisma.waMessage.findFirst({
    where: { id: req.params.messageId, tenantId },
    select: { id: true, mediaId: true, mediaFilename: true },
  });
  if (!msg || !msg.mediaId) return res.status(404).json({ error: "Mídia não encontrada" });

  try {
    const media = await getOrCacheMessageMedia(prisma, tenantId, msg);
    const inline = isInlineSafeMime(media.mime);
    const nome = (msg.mediaFilename || `arquivo-${msg.id.slice(0, 8)}`).replace(/[^\w.\- ]+/g, "_");
    res.setHeader("Content-Type", inline ? media.mime : "application/octet-stream");
    res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${nome}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Content-Length", String(media.data.length));
    return res.status(200).end(media.data);
  } catch (e) {
    if (e instanceof MediaError) {
      const status = e.code === "SEM_TOKEN" ? 503 : e.code === "MUITO_GRANDE" ? 413 : 502;
      const texto =
        e.code === "SEM_TOKEN"
          ? "Configure WHATSAPP_ACCESS_TOKEN na Vercel para baixar mídias."
          : e.code === "MUITO_GRANDE"
            ? `Arquivo maior que ${MEDIA_MAX_BYTES / 1048576} MB: não dá para exibir aqui.`
            : "Mídia indisponível (pode ter expirado na Meta).";
      return res.status(status).json({ error: texto, codigo: e.code });
    }
    throw e;
  }
});

export default router;

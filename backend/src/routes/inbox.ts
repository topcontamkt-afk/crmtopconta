import { Request, Response, Router } from "express";
import { z } from "zod";
import { prisma } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../middleware/audit";
import { maskPhone } from "../services/masking";
import { classificarPerfil } from "../services/rendaPerfil";
import { getOrCacheMessageMedia, isInlineSafeMime, MediaError, MEDIA_MAX_BYTES } from "../services/whatsappMedia";
import { isSendableTemplate, previewTemplateFor, sendReply, sendTemplateReply } from "../services/whatsappReply";
import { SendError, OUTBOUND_MAX_BYTES } from "../services/whatsappSend";
import { accessTokenFor, credentialsOf } from "../services/whatsappAccount";
import { janelaAte } from "../services/whatsappPayload";
import { AUTO_REPLY_JANELA_MS, AUTO_REPLY_MAX, AUTO_REPLY_PADRAO, autoReplyTextOf } from "../services/whatsappAutoReply";

/**
 * Inbox do WhatsApp (Fase 1): lista de conversas e histórico de mensagens recebidas. Leitura e
 * "marcar como lida" — o envio de respostas é a Fase 3. Telefones aparecem mascarados (LGPD).
 */
const router = Router();
router.use(requireAuth);

/** GET /api/inbox/status — o WhatsApp está conectado? (a configuração fica em Integrações) */
router.get("/status", async (req, res) => {
  const { tenantId } = req.user!;
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { whatsappProvider: true } });
  const ativo = tenant?.whatsappProvider === "ZAPI" ? "ZAPI" : "META";
  // A Inbox mostra as conversas das duas conexões; o "conectado?" vale para a conexão ATIVA (Configurações → WhatsApp)
  const account = await prisma.whatsAppAccount.findFirst({ where: { tenantId, active: true, provider: ativo }, orderBy: { createdAt: "asc" } });
  const cred = credentialsOf(account && account.credentials ? account : null);
  res.json({
    provider: ativo,
    account: account ? { id: account.id, phoneNumberId: account.phoneNumberId, displayName: account.displayName, displayPhone: account.displayPhone } : null,
    config: ativo === "ZAPI" ? { appSecret: true, accessToken: true } : { appSecret: !!cred.appSecret, accessToken: !!cred.accessToken },
  });
});

/**
 * GET /api/inbox/resumo — leve, para o aviso de mensagem nova que roda em qualquer tela: quantas
 * conversas têm mensagem não lida e qual foi a última a chegar (o front compara com o que já viu).
 * LGPD 07-05: só id e horário; nome e trecho da mensagem não saem daqui (o aviso aparece em qualquer
 * tela e na notificação do sistema operacional). O conteúdo só se vê dentro da Inbox.
 */
router.get("/resumo", async (req, res) => {
  const { tenantId } = req.user!;
  const [naoLidas, ultima] = await Promise.all([
    prisma.conversation.count({ where: { tenantId, status: "ABERTA", unreadCount: { gt: 0 } } }),
    prisma.conversation.findFirst({
      where: { tenantId, status: "ABERTA", unreadCount: { gt: 0 }, lastInboundAt: { not: null } },
      orderBy: { lastInboundAt: "desc" },
      select: { id: true, lastInboundAt: true },
    }),
  ]);
  res.json({
    naoLidas,
    ultima: ultima ? { id: ultima.id, em: ultima.lastInboundAt!.toISOString() } : null,
  });
});

/** GET /api/inbox/auto-reply — configuração da resposta automática da conta ativa. */
router.get("/auto-reply", async (req, res) => {
  const { tenantId } = req.user!;
  const account = await prisma.whatsAppAccount.findFirst({ where: { tenantId, active: true, provider: "META" }, orderBy: { createdAt: "asc" } });
  if (!account) return res.status(404).json({ error: "WhatsApp não conectado" });
  res.json({
    ativa: account.autoReplyEnabled,
    texto: autoReplyTextOf(account),
    padrao: AUTO_REPLY_PADRAO,
    personalizado: !!account.autoReplyText?.trim(),
    maximo: AUTO_REPLY_MAX,
    janelaHoras: AUTO_REPLY_JANELA_MS / 3600_000,
  });
});

const autoReplySchema = z.object({ ativa: z.boolean(), texto: z.string().max(4096) });

/** PUT /api/inbox/auto-reply (ADMIN) — liga/desliga e troca o texto; texto igual ao padrão ou vazio volta ao padrão. */
router.put("/auto-reply", requireRole("ADMIN"), async (req, res) => {
  const parsed = autoReplySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos" });
  const { tenantId } = req.user!;
  const account = await prisma.whatsAppAccount.findFirst({ where: { tenantId, active: true, provider: "META" }, orderBy: { createdAt: "asc" } });
  if (!account) return res.status(404).json({ error: "WhatsApp não conectado" });
  const texto = parsed.data.texto.trim();
  if (parsed.data.ativa && !texto) return res.status(400).json({ error: "Escreva a mensagem da resposta automática." });
  await prisma.whatsAppAccount.update({
    where: { id: account.id },
    data: { autoReplyEnabled: parsed.data.ativa, autoReplyText: !texto || texto === AUTO_REPLY_PADRAO ? null : texto },
  });
  await logAudit({ tenantId, userId: req.user!.id, action: "WHATSAPP_AUTO_REPLY_UPDATE", target: "WhatsAppAccount", targetId: account.id, details: { ativa: parsed.data.ativa } });
  res.json({ ok: true });
});

const listQuery = z.object({
  filtro: z.enum(["todas", "nao_lidas", "janela_aberta", "sem_cliente"]).default("todas"),
  busca: z.string().max(80).optional(),
  limite: z.coerce.number().int().min(1).max(100).default(50),
});

/** LGPD 07-03: nome ou telefone procurado não vai na URL (logs de requisição). */
const BUSCA_NA_URL = "A busca por nome ou telefone não vai mais na URL (LGPD). Use POST /api/inbox/conversations/search com o termo no corpo.";

/** GET /api/inbox/conversations — só filtros não pessoais na URL. */
router.get("/conversations", async (req, res) => {
  if (req.query.busca !== undefined) return res.status(400).json({ error: BUSCA_NA_URL });
  await listarConversas(req, res, req.query);
});

/** POST /api/inbox/conversations/search — LGPD 07-03: a mesma lista, com a busca e os filtros no corpo. */
router.post("/conversations/search", async (req, res) => {
  await listarConversas(req, res, req.body ?? {});
});

async function listarConversas(req: Request, res: Response, src: unknown) {
  const q = listQuery.safeParse(src);
  if (!q.success) return res.status(400).json({ error: "Parâmetros inválidos" });
  const { tenantId } = req.user!;
  const { filtro, busca, limite } = q.data;

  const where: any = { tenantId, status: "ABERTA" };
  if (filtro === "nao_lidas") where.unreadCount = { gt: 0 };
  // Z-API não tem janela de 24h: essas conversas contam sempre como abertas
  if (filtro === "janela_aberta") where.OR = [{ lastInboundAt: { gte: new Date(Date.now() - 24 * 3600_000) } }, { account: { is: { provider: "ZAPI" } } }];
  if (filtro === "sem_cliente") where.clientId = null;
  if (busca?.trim()) {
    const t = busca.trim();
    where.AND = [{ OR: [
      { contactName: { contains: t, mode: "insensitive" } },
      { client: { is: { nome: { contains: t, mode: "insensitive" } } } },
      ...(/\d{4,}/.test(t) ? [{ waId: { contains: t.replace(/\D/g, "") } }] : []),
    ] }];
  }

  const [rows, naoLidas] = await Promise.all([
    prisma.conversation.findMany({
      where,
      orderBy: { lastMessageAt: "desc" },
      take: limite,
      include: { client: { select: { id: true, nome: true, cidade: true } }, account: { select: { provider: true } } },
    }),
    prisma.conversation.count({ where: { tenantId, status: "ABERTA", unreadCount: { gt: 0 } } }),
  ]);

  const agora = Date.now();
  res.json({
    naoLidas,
    conversas: rows.map((c) => {
      const zapi = c.account.provider === "ZAPI";
      const ate = zapi ? null : janelaAte(c.lastInboundAt);
      return {
        canal: c.account.provider,
        id: c.id,
        nome: c.client?.nome ?? c.contactName ?? "Contato sem cadastro",
        cidade: c.client?.cidade ?? null,
        clienteId: c.clientId,
        telefone: maskPhone(c.waId),
        preview: c.lastPreview,
        ultimaMensagemEm: c.lastMessageAt.toISOString(),
        naoLidas: c.unreadCount,
        janelaAberta: zapi || (!!ate && ate.getTime() > agora),
        janelaAte: ate?.toISOString() ?? null,
      };
    }),
  });
}

const msgsQuery = z.object({ antes: z.string().datetime().optional(), limite: z.coerce.number().int().min(1).max(200).default(100) });

/** GET /api/inbox/conversations/:id/messages — mais antigas primeiro; `antes` pagina para trás. */
router.get("/conversations/:id/messages", async (req, res) => {
  const q = msgsQuery.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: "Parâmetros inválidos" });
  const { tenantId } = req.user!;
  const conversa = await prisma.conversation.findFirst({
    where: { id: req.params.id, tenantId },
    include: {
      client: { select: { id: true, nome: true, cidade: true, limiteTotal: true, saldoDisponivel: true, faixaUso: true, autorizacaoComunicacao: true, optOutAt: true } },
      account: { select: { provider: true } },
    },
  });
  if (!conversa) return res.status(404).json({ error: "Conversa não encontrada" });

  const mensagens = await prisma.waMessage.findMany({
    where: { tenantId, conversationId: conversa.id, ...(q.data.antes ? { timestamp: { lt: new Date(q.data.antes) } } : {}) },
    orderBy: { timestamp: "desc" },
    take: q.data.limite,
  });
  mensagens.reverse();

  const zapi = conversa.account.provider === "ZAPI";
  const ate = zapi ? null : janelaAte(conversa.lastInboundAt);
  const c = conversa.client;
  res.json({
    conversa: {
      id: conversa.id,
      nome: c?.nome ?? conversa.contactName ?? "Contato sem cadastro",
      telefone: maskPhone(conversa.waId),
      canal: conversa.account.provider,
      janelaAberta: zapi || (!!ate && ate.getTime() > Date.now()),
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
      automatica: m.automatic,
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
  automatica: m.automatic,
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
      const status = { NAO_ENCONTRADA: 404, OPT_OUT: 403, TEMPLATE_INDISPONIVEL: 409, JANELA_FECHADA: 409, SEM_TOKEN: 503, TIPO_INVALIDO: 400, MUITO_GRANDE: 413, META: 502 }[e.code];
      return res.status(status).json({ error: e.message, codigo: e.code, metaCodigo: e.metaCode });
    }
    throw e;
  }
});

/** GET /api/inbox/conversations/:id/templates — templates aprovados, já com o texto que ESTE cliente receberia. */
router.get("/conversations/:id/templates", async (req, res) => {
  const { tenantId } = req.user!;
  const conversa = await prisma.conversation.findFirst({ where: { id: req.params.id, tenantId }, include: { client: true } });
  if (!conversa) return res.status(404).json({ error: "Conversa não encontrada" });
  const templates = await prisma.messageTemplate.findMany({ where: { tenantId, channel: "WHATSAPP", status: "APROVADO" }, orderBy: { name: "asc" } });
  res.json(
    templates.filter(isSendableTemplate).map((t) => ({
      id: t.id,
      nome: t.name,
      categoria: t.category,
      texto: previewTemplateFor(t, conversa).texto,
      botoes: (t.quickReplies as string[] | null) ?? [],
    }))
  );
});

/** POST /api/inbox/conversations/:id/template — envia um template aprovado (único caminho fora da janela de 24h). */
router.post("/conversations/:id/template", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const parsed = z.object({ templateId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Escolha um template", codigo: "TIPO_INVALIDO" });
  const { tenantId, id: userId } = req.user!;
  try {
    const message = await sendTemplateReply(prisma, tenantId, userId, req.params.id, parsed.data.templateId);
    res.status(201).json(presentMessage(message));
  } catch (e) {
    if (e instanceof SendError) {
      const status = { NAO_ENCONTRADA: 404, OPT_OUT: 403, TEMPLATE_INDISPONIVEL: 409, JANELA_FECHADA: 409, SEM_TOKEN: 503, TIPO_INVALIDO: 400, MUITO_GRANDE: 413, META: 502 }[e.code];
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
    const token = await accessTokenFor(prisma, tenantId);
    const media = await getOrCacheMessageMedia(prisma, tenantId, msg, token);
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
          ? "Configure o Access Token em Integrações > WhatsApp para baixar mídias."
          : e.code === "MUITO_GRANDE"
            ? `Arquivo maior que ${MEDIA_MAX_BYTES / 1048576} MB: não dá para exibir aqui.`
            : "Mídia indisponível (pode ter expirado na Meta).";
      return res.status(status).json({ error: texto, codigo: e.code });
    }
    throw e;
  }
});

export default router;

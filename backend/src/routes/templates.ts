import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../middleware/audit";
import { renderTemplate } from "../services/campaignQueue";
import { credentialsOf } from "../services/whatsappAccount";
import { SendError } from "../services/whatsappSend";
import { syncTemplatesFromMeta } from "../services/whatsappTemplateSync";
import {
  buildBodyParams,
  buildCreatePayload,
  createMetaTemplate,
  deleteMetaTemplate,
  mapMetaStatus,
  renderMetaPreview,
  SAMPLE_VALUES,
  TEMPLATE_CATEGORIES,
  validateTemplate,
  variableOrder,
} from "../services/whatsappTemplates";

const router = Router();
router.use(requireAuth);

/** Conta WhatsApp do tenant + token: o que é preciso para falar com a Meta sobre templates. */
async function metaContext(tenantId: string) {
  const account = await prisma.whatsAppAccount.findFirst({ where: { tenantId, active: true }, orderBy: { createdAt: "asc" } });
  const token = credentialsOf(account).accessToken;
  return {
    account,
    token,
    wabaId: account?.wabaId ?? null,
    configurado: !!(account?.wabaId && token),
    faltando: [!account && "WhatsApp conectado em Integrações", account && !account.wabaId && "WABA ID", !token && "Access Token"].filter(Boolean) as string[],
  };
}

const present = (t: any) => ({ ...t, variaveis: t.channel === "WHATSAPP" ? variableOrder(t.body) : [] });

function sendError(res: any, e: unknown) {
  if (e instanceof SendError) {
    const status = e.code === "SEM_TOKEN" ? 503 : e.code === "META" ? 502 : 400;
    return res.status(status).json({ error: e.message, codigo: e.code });
  }
  throw e;
}

/** GET /api/templates/meta-status — a conexão com a Meta para templates está pronta? */
router.get("/meta-status", async (req, res) => {
  const ctx = await metaContext(req.user!.tenantId);
  res.json({ configurado: ctx.configurado, faltando: ctx.faltando, wabaId: ctx.wabaId });
});

router.get("/", async (req, res) => {
  const { channel, status } = req.query;
  const templates = await prisma.messageTemplate.findMany({
    where: {
      tenantId: req.user!.tenantId,
      channel: channel ? (String(channel) as any) : undefined,
      status: status ? (String(status) as any) : undefined,
    },
    orderBy: { updatedAt: "desc" },
  });
  res.json(templates.map(present));
});

const createSchema = z.object({
  channel: z.enum(["WHATSAPP", "SMS"]),
  name: z.string().min(1).max(120),
  body: z.string().min(1),
  category: z.enum(TEMPLATE_CATEGORIES).optional(),
  footer: z.string().max(200).optional(),
  quickReplies: z.array(z.string().max(60)).max(5).optional(),
});

router.post("/", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: userId } = req.user!;
  const d = parsed.data;

  if (d.channel === "WHATSAPP") {
    const erros = validateTemplate({ body: d.body, footer: d.footer, quickReplies: d.quickReplies, category: d.category });
    if (erros.length) return res.status(400).json({ error: erros.join(" "), erros });
  }

  // WhatsApp: nasce como rascunho e só vira "pendente" quando é ENVIADO à Meta (POST /:id/submit).
  // SMS não tem aprovação e já nasce aprovado.
  const template = await prisma.messageTemplate.create({
    data: {
      tenantId,
      channel: d.channel,
      name: d.name,
      body: d.body,
      status: d.channel === "WHATSAPP" ? "RASCUNHO" : "APROVADO",
      ...(d.channel === "WHATSAPP"
        ? { category: d.category, footer: d.footer?.trim() || null, quickReplies: d.quickReplies?.map((b) => b.trim()).filter(Boolean) ?? [] }
        : {}),
    },
  });
  await logAudit({ tenantId, userId, action: "CREATE_TEMPLATE", target: "MessageTemplate", targetId: template.id });
  res.status(201).json(present(template));
});

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  body: z.string().min(1).optional(),
  category: z.enum(TEMPLATE_CATEGORIES).optional(),
  footer: z.string().max(200).nullable().optional(),
  quickReplies: z.array(z.string().max(60)).max(5).optional(),
  // Aprovação manual: só existe para ambiente sem Meta (desenvolvimento). Com a Meta conectada o status vem dela.
  status: z.enum(["RASCUNHO", "PENDENTE_APROVACAO", "APROVADO", "REJEITADO"]).optional(),
  rejectionReason: z.string().optional(),
});

router.patch("/:id", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: userId } = req.user!;

  const template = await prisma.messageTemplate.findFirst({ where: { id: req.params.id, tenantId } });
  if (!template) return res.status(404).json({ error: "Template não encontrado" });

  const data: any = { ...parsed.data };
  if (template.channel === "WHATSAPP") {
    if (parsed.data.status) {
      const ctx = await metaContext(tenantId);
      if (ctx.configurado) return res.status(409).json({ error: "O status vem da Meta: envie para aprovação ou sincronize. A aprovação manual só existe sem a Meta conectada." });
    }
    const merged = {
      body: parsed.data.body ?? template.body,
      footer: parsed.data.footer === undefined ? template.footer : parsed.data.footer,
      quickReplies: parsed.data.quickReplies ?? ((template.quickReplies as string[] | null) ?? []),
      category: parsed.data.category ?? template.category,
    };
    const erros = validateTemplate(merged);
    if (erros.length) return res.status(400).json({ error: erros.join(" "), erros });
    if (parsed.data.quickReplies) data.quickReplies = parsed.data.quickReplies.map((b) => b.trim()).filter(Boolean);

    // Mudou o conteúdo de um template que já foi para a Meta: é uma NOVA versão, que precisa de nova aprovação.
    const mudouConteudo =
      merged.body !== template.body ||
      (merged.footer ?? null) !== (template.footer ?? null) ||
      JSON.stringify(merged.quickReplies) !== JSON.stringify(template.quickReplies ?? []) ||
      merged.category !== template.category;
    if (mudouConteudo && template.metaName) {
      Object.assign(data, { version: template.version + 1, metaName: null, providerTemplateId: null, metaStatus: null, submittedAt: null, status: "RASCUNHO", rejectionReason: null });
    }
  }

  const updated = await prisma.messageTemplate.update({ where: { id: template.id }, data });
  await logAudit({ tenantId, userId, action: "UPDATE_TEMPLATE", target: "MessageTemplate", targetId: template.id, details: Object.keys(parsed.data) });
  res.json(present(updated));
});

/** POST /api/templates/:id/submit — cria o template na Meta e envia para aprovação. */
router.post("/:id/submit", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const { tenantId, id: userId } = req.user!;
  const template = await prisma.messageTemplate.findFirst({ where: { id: req.params.id, tenantId } });
  if (!template) return res.status(404).json({ error: "Template não encontrado" });
  if (template.channel !== "WHATSAPP") return res.status(400).json({ error: "Só templates de WhatsApp passam pela Meta." });
  if (template.metaName) return res.status(409).json({ error: "Este template já foi enviado à Meta. Para mudar o texto, edite-o (isso gera uma nova versão)." });

  const erros = validateTemplate({ body: template.body, footer: template.footer, quickReplies: (template.quickReplies as string[] | null) ?? [], category: template.category });
  if (erros.length) return res.status(400).json({ error: erros.join(" "), erros });

  const ctx = await metaContext(tenantId);
  if (!ctx.configurado) return res.status(409).json({ error: `Falta configurar: ${ctx.faltando.join(", ")}.` });

  const payload = buildCreatePayload({ ...template, quickReplies: (template.quickReplies as string[] | null) ?? [], category: template.category });
  try {
    const created = await createMetaTemplate(ctx.wabaId!, ctx.token, payload);
    const updated = await prisma.messageTemplate.update({
      where: { id: template.id },
      data: {
        metaName: payload.name,
        providerTemplateId: created.id,
        metaStatus: created.status,
        status: mapMetaStatus(created.status) ?? "PENDENTE_APROVACAO",
        submittedAt: new Date(),
        rejectionReason: null,
      },
    });
    await logAudit({ tenantId, userId, action: "SUBMIT_TEMPLATE", target: "MessageTemplate", targetId: template.id, details: { metaName: payload.name } });
    res.json(present(updated));
  } catch (e) {
    return sendError(res, e);
  }
});

/** POST /api/templates/sync — puxa da Meta o status de todos os templates (plano B ao webhook). */
router.post("/sync", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const { tenantId } = req.user!;
  const ctx = await metaContext(tenantId);
  if (!ctx.configurado) return res.status(409).json({ error: `Falta configurar: ${ctx.faltando.join(", ")}.` });
  try {
    res.json(await syncTemplatesFromMeta(prisma, tenantId, ctx.wabaId!, ctx.token));
  } catch (e) {
    return sendError(res, e);
  }
});

router.delete("/:id", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const { tenantId, id: userId } = req.user!;
  const template = await prisma.messageTemplate.findFirst({ where: { id: req.params.id, tenantId } });
  if (!template) return res.status(404).json({ error: "Template não encontrado" });

  // Remove também na Meta (melhor esforço: se a Meta falhar, o template local sai do mesmo jeito).
  if (template.channel === "WHATSAPP" && template.metaName) {
    const ctx = await metaContext(tenantId);
    if (ctx.configurado) await deleteMetaTemplate(ctx.wabaId!, ctx.token, template.metaName).catch((e) => console.warn("[templates] exclusão na Meta falhou:", e.message));
  }
  await prisma.messageTemplate.delete({ where: { id: template.id } });
  await logAudit({ tenantId, userId, action: "DELETE_TEMPLATE", target: "MessageTemplate", targetId: template.id });
  res.status(204).send();
});

const previewSchema = z.object({
  sample: z.record(z.any()).default({ nome: "Maria Silva", cidade: "São Paulo", percentual: 45, saldo: "R$ 850,00", limite: "R$ 1.500,00" }),
});

/** POST /api/templates/:id/preview — pré-visualização com as variáveis substituídas. */
router.post("/:id/preview", async (req, res) => {
  const parsed = previewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const template = await prisma.messageTemplate.findFirst({ where: { id: req.params.id, tenantId: req.user!.tenantId } });
  if (!template) return res.status(404).json({ error: "Template não encontrado" });

  const rendered =
    template.channel === "WHATSAPP"
      ? renderMetaPreview(template.body, buildBodyParams(template.body, { ...SAMPLE_VALUES, ...parsed.data.sample }))
      : renderTemplate(template.body, parsed.data.sample);
  res.json({ rendered });
});

export default router;

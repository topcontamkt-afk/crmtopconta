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
  buildCreatePayload,
  createMetaTemplate,
  deleteMetaTemplate,
  mapMetaStatus,
  CtaButton,
  LANGUAGES,
  normalizeButtonPhone,
  SAMPLE_VALUES,
  TEMPLATE_CATEGORIES,
  templateParams,
  templatePreview,
  uploadTemplateExample,
  validateTemplate,
  variableOrder,
} from "../services/whatsappTemplates";
import { applyVariableMap, positionsIn, unmappedPositions, validateVariableMap } from "../services/templateImport";
import { OUTBOUND_MAX_BYTES } from "../services/whatsappSend";
import { linkBase } from "../services/trackedLinks";
import { deleteTemplateMedia, loadTemplateMedia, saveTemplateMedia } from "../services/mediaStore";

const router = Router();
router.use(requireAuth);

/** Conta WhatsApp do tenant + token: o que é preciso para falar com a Meta sobre templates. */
async function metaContext(tenantId: string) {
  const account = await prisma.whatsAppAccount.findFirst({ where: { tenantId, active: true, provider: "META" }, orderBy: { createdAt: "asc" } });
  const token = credentialsOf(account).accessToken;
  return {
    account,
    token,
    wabaId: account?.wabaId ?? null,
    configurado: !!(account?.wabaId && token),
    faltando: [!account && "WhatsApp conectado em Integrações", account && !account.wabaId && "WABA ID", !token && "Access Token"].filter(Boolean) as string[],
  };
}

const present = (t: any) => {
  const { media, ...rest } = t;
  return {
    ...rest,
    variaveis: t.channel === "WHATSAPP" ? (t.metaBody ? positionsIn(t.metaBody).map((n) => `{{${n}}}`) : variableOrder(t.body)) : [],
    // posições do template importado que ainda não dizem qual variável nossa preenche
    variaveisSemMapa: unmappedPositions(t.variableMap),
    imagem: media ? { mime: media.mime, size: media.size, filename: media.filename } : null,
  };
};

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
    include: { media: { select: { mime: true, size: true, filename: true } } },
  });
  res.json(templates.map(present));
});

const ctaSchema = z.object({
  type: z.enum(["URL", "PHONE_NUMBER"]),
  text: z.string().max(60),
  url: z.string().max(2100).optional(),
  tracked: z.boolean().optional(),
  phone: z.string().max(40).optional(),
});

/** Botões de chamada para ação já limpos: telefone no formato +DDI..., espaços cortados. */
function cleanCtas(list: z.infer<typeof ctaSchema>[] | undefined): CtaButton[] {
  return (list ?? []).map((b) =>
    b.type === "URL"
      ? { type: "URL", text: b.text.trim(), url: (b.url ?? "").trim(), ...(b.tracked ? { tracked: true } : {}) }
      : { type: "PHONE_NUMBER", text: b.text.trim(), phone: normalizeButtonPhone(b.phone ?? "") ?? (b.phone ?? "").trim() }
  );
}

/**
 * O que exige nova aprovação na Meta: no link rastreado o DESTINO fica só aqui (a Meta recebe o nosso
 * endereço /r/{{1}}), então trocar o destino não muda a assinatura; trocar o texto, o tipo ou o rastreio muda.
 */
function buttonsSignature(list: CtaButton[] | null | undefined): string {
  return JSON.stringify((list ?? []).map((b) => ({ type: b.type, text: b.text, tracked: !!b.tracked, url: b.type === "URL" && !b.tracked ? b.url : "", phone: b.phone ?? "" })));
}

const createSchema = z.object({
  channel: z.enum(["WHATSAPP", "SMS"]),
  name: z.string().min(1).max(120),
  body: z.string().min(1),
  category: z.enum(TEMPLATE_CATEGORIES).optional(),
  footer: z.string().max(200).optional(),
  quickReplies: z.array(z.string().max(60)).max(12).optional(),
  buttons: z.array(ctaSchema).max(6).optional(),
  language: z.enum(LANGUAGES).optional(),
});

router.post("/", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: userId } = req.user!;
  const d = parsed.data;

  if (d.channel === "WHATSAPP") {
    const erros = validateTemplate({ body: d.body, footer: d.footer, quickReplies: d.quickReplies, buttons: cleanCtas(d.buttons), category: d.category });
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
        ? {
            category: d.category,
            footer: d.footer?.trim() || null,
            quickReplies: d.quickReplies?.map((b) => b.trim()).filter(Boolean) ?? [],
            buttons: cleanCtas(d.buttons) as any,
            ...(d.language ? { language: d.language } : {}),
          }
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
  quickReplies: z.array(z.string().max(60)).max(12).optional(),
  buttons: z.array(ctaSchema).max(6).optional(),
  language: z.enum(LANGUAGES).optional(),
  // Aprovação manual: só existe para ambiente sem Meta (desenvolvimento). Com a Meta conectada o status vem dela.
  status: z.enum(["RASCUNHO", "PENDENTE_APROVACAO", "APROVADO", "REJEITADO"]).optional(),
  rejectionReason: z.string().optional(),
  // Template importado da Meta: o que cada {{1}}, {{2}}... significa (não muda o conteúdo na Meta).
  variableMap: z.array(z.string().nullable()).optional(),
});

router.patch("/:id", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: userId } = req.user!;

  const template = await prisma.messageTemplate.findFirst({ where: { id: req.params.id, tenantId } });
  if (!template) return res.status(404).json({ error: "Template não encontrado" });

  const data: any = { ...parsed.data };
  delete data.variableMap;
  delete data.buttons;
  if (parsed.data.variableMap !== undefined) {
    if (!template.metaBody) return res.status(400).json({ error: "Só templates importados da Meta têm mapa de variáveis." });
    const invalido = validateVariableMap(parsed.data.variableMap, positionsIn(template.metaBody).length);
    if (invalido) return res.status(400).json({ error: invalido });
    data.variableMap = parsed.data.variableMap;
    data.body = applyVariableMap(template.metaBody, parsed.data.variableMap);
  }
  if (template.origin === "META" && (parsed.data.body !== undefined || parsed.data.footer !== undefined || parsed.data.quickReplies !== undefined || parsed.data.buttons !== undefined || parsed.data.category !== undefined)) {
    return res.status(409).json({ error: "Este template veio da Meta: o texto só muda lá. Aqui você pode ajustar o nome e o significado das variáveis, ou criar um template novo." });
  }
  if (template.channel === "WHATSAPP" && template.origin !== "META") {
    if (parsed.data.status) {
      const ctx = await metaContext(tenantId);
      if (ctx.configurado) return res.status(409).json({ error: "O status vem da Meta: envie para aprovação ou sincronize. A aprovação manual só existe sem a Meta conectada." });
    }
    const merged = {
      body: parsed.data.body ?? template.body,
      footer: parsed.data.footer === undefined ? template.footer : parsed.data.footer,
      quickReplies: parsed.data.quickReplies ?? ((template.quickReplies as string[] | null) ?? []),
      buttons: parsed.data.buttons ? cleanCtas(parsed.data.buttons) : ((template.buttons as CtaButton[] | null) ?? []),
      category: parsed.data.category ?? template.category,
    };
    const erros = validateTemplate(merged);
    if (erros.length) return res.status(400).json({ error: erros.join(" "), erros });
    if (parsed.data.quickReplies) data.quickReplies = parsed.data.quickReplies.map((b) => b.trim()).filter(Boolean);
    if (parsed.data.buttons) data.buttons = merged.buttons as any;

    // Mudou o conteúdo de um template que já foi para a Meta: é uma NOVA versão, que precisa de nova aprovação.
    const mudouConteudo =
      merged.body !== template.body ||
      (merged.footer ?? null) !== (template.footer ?? null) ||
      JSON.stringify(merged.quickReplies) !== JSON.stringify(template.quickReplies ?? []) ||
      buttonsSignature(merged.buttons) !== buttonsSignature((template.buttons as CtaButton[] | null) ?? []) ||
      (parsed.data.language !== undefined && parsed.data.language !== template.language) ||
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

  const erros = validateTemplate({ body: template.body, footer: template.footer, quickReplies: (template.quickReplies as string[] | null) ?? [], buttons: (template.buttons as CtaButton[] | null) ?? [], category: template.category });
  if (erros.length) return res.status(400).json({ error: erros.join(" "), erros });

  const ctx = await metaContext(tenantId);
  if (!ctx.configurado) return res.status(409).json({ error: `Falta configurar: ${ctx.faltando.join(", ")}.` });

  try {
    // Cabeçalho com imagem: a Meta exige uma imagem de exemplo, enviada por upload resumível (precisa do ID do app).
    let headerHandle: string | null = null;
    if (template.headerFormat === "IMAGE") {
      const media = await loadTemplateMedia(prisma, tenantId, template.id);
      if (!media) return res.status(400).json({ error: "Este template tem cabeçalho de imagem, mas a imagem não foi enviada." });
      if (!ctx.account?.appId) return res.status(409).json({ error: "Para enviar um template com imagem, informe o ID do app da Meta em Integrações > WhatsApp." });
      headerHandle = await uploadTemplateExample(ctx.account.appId, ctx.token, media.data, media.mime, media.filename);
      await prisma.messageTemplate.update({ where: { id: template.id }, data: { headerHandle } });
    }
    const payload = buildCreatePayload({ ...template, quickReplies: (template.quickReplies as string[] | null) ?? [], buttons: (template.buttons as CtaButton[] | null) ?? [], category: template.category, headerHandle, linkBase: linkBase() ?? undefined });
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
  // Template importado da Meta pode estar em uso por outro sistema: aqui só sai do nosso cadastro.
  if (template.channel === "WHATSAPP" && template.metaName && template.origin !== "META") {
    const ctx = await metaContext(tenantId);
    if (ctx.configurado) await deleteMetaTemplate(ctx.wabaId!, ctx.token, template.metaName).catch((e) => console.warn("[templates] exclusão na Meta falhou:", e.message));
  }
  // a imagem do cabeçalho sai antes: a linha cairia em cascata, mas o arquivo no R2 ficaria sem dono
  await deleteTemplateMedia(prisma, tenantId, template.id);
  await prisma.messageTemplate.delete({ where: { id: template.id } });
  await logAudit({ tenantId, userId, action: "DELETE_TEMPLATE", target: "MessageTemplate", targetId: template.id });
  res.status(204).send();
});


const IMAGE_MIMES = ["image/jpeg", "image/png"];
function looksLikeImage(buf: Buffer, mime: string): boolean {
  if (mime === "image/png") return buf.length > 8 && buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

const headerSchema = z.object({ data: z.string().min(1), mime: z.string(), filename: z.string().min(1).max(200) });

/** PUT /api/templates/:id/header — define a imagem do cabeçalho (JPG/PNG até 3 MB, em base64). */
router.put("/:id/header", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const parsed = headerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Envie a imagem (data, mime e filename)." });
  const { tenantId, id: userId } = req.user!;
  const template = await prisma.messageTemplate.findFirst({ where: { id: req.params.id, tenantId } });
  if (!template || template.channel !== "WHATSAPP") return res.status(404).json({ error: "Template do WhatsApp não encontrado" });
  if (template.origin === "META" && template.metaName) {
    // Importado: a imagem aqui é só a que ENVIAMOS no cabeçalho (a Meta já aprovou o template com uma imagem de exemplo).
    if (template.headerFormat !== "IMAGE") return res.status(409).json({ error: "Este template da Meta não tem cabeçalho de imagem." });
  }
  const mime = parsed.data.mime.split(";")[0].trim().toLowerCase();
  if (!IMAGE_MIMES.includes(mime)) return res.status(400).json({ error: "A imagem precisa ser JPG ou PNG." });
  const buf = Buffer.from(parsed.data.data, "base64");
  if (buf.length > OUTBOUND_MAX_BYTES) return res.status(413).json({ error: "A imagem passa de 3 MB." });
  if (!looksLikeImage(buf, mime)) return res.status(400).json({ error: "O arquivo não parece uma imagem JPG/PNG válida." });

  await saveTemplateMedia(prisma, tenantId, template.id, { mime, filename: parsed.data.filename, data: buf });
  const data: any = { headerFormat: "IMAGE" };
  // Template nosso que já foi para a Meta: trocar o cabeçalho é nova versão (precisa de nova aprovação).
  if (template.origin !== "META" && template.metaName) {
    Object.assign(data, { version: template.version + 1, metaName: null, providerTemplateId: null, metaStatus: null, submittedAt: null, status: "RASCUNHO", rejectionReason: null, headerHandle: null });
  }
  const updated = await prisma.messageTemplate.update({ where: { id: template.id }, data, include: { media: { select: { mime: true, size: true, filename: true } } } });
  await logAudit({ tenantId, userId, action: "SET_TEMPLATE_HEADER", target: "MessageTemplate", targetId: template.id, details: { size: buf.length } });
  res.json(present(updated));
});

/** DELETE /api/templates/:id/header — tira a imagem (só templates nossos que ainda não foram à Meta). */
router.delete("/:id/header", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const { tenantId, id: userId } = req.user!;
  const template = await prisma.messageTemplate.findFirst({ where: { id: req.params.id, tenantId } });
  if (!template) return res.status(404).json({ error: "Template não encontrado" });
  if (template.origin === "META" || template.metaName) return res.status(409).json({ error: "Este template já tem o cabeçalho de imagem aprovado na Meta." });
  await deleteTemplateMedia(prisma, tenantId, template.id);
  await prisma.messageTemplate.update({ where: { id: template.id }, data: { headerFormat: null, headerHandle: null } });
  await logAudit({ tenantId, userId, action: "REMOVE_TEMPLATE_HEADER", target: "MessageTemplate", targetId: template.id });
  res.status(204).send();
});

/** GET /api/templates/:id/header — a imagem (autenticado, para a pré-visualização). */
router.get("/:id/header", async (req, res) => {
  const media = await loadTemplateMedia(prisma, req.user!.tenantId, req.params.id);
  if (!media) return res.status(404).json({ error: "Sem imagem" });
  res.setHeader("Content-Type", media.mime);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, max-age=300");
  res.send(media.data);
});

const previewSchema = z.object({
  sample: z.record(z.any()).default({ nome: "Maria Silva", cidade: "São Paulo", percentual: 45, saldo: "R$ 850,00", limite: "R$ 1.500,00", limite_disponivel: "R$ 850,00" }),
});

/** POST /api/templates/:id/preview — pré-visualização com as variáveis substituídas. */
router.post("/:id/preview", async (req, res) => {
  const parsed = previewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const template = await prisma.messageTemplate.findFirst({ where: { id: req.params.id, tenantId: req.user!.tenantId } });
  if (!template) return res.status(404).json({ error: "Template não encontrado" });

  const rendered =
    template.channel === "WHATSAPP"
      ? templatePreview(template, templateParams(template, { ...SAMPLE_VALUES, ...parsed.data.sample }))
      : renderTemplate(template.body, parsed.data.sample);
  res.json({ rendered });
});

export default router;

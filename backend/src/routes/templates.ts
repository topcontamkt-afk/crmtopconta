import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../middleware/audit";
import { renderTemplate } from "../services/campaignQueue";

const router = Router();
router.use(requireAuth);

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
  res.json(templates);
});

const createSchema = z.object({
  channel: z.enum(["WHATSAPP", "SMS"]),
  name: z.string().min(1),
  body: z.string().min(1),
});

router.post("/", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: userId } = req.user!;

  // WhatsApp exige aprovação prévia do provedor para templates fora da janela de 24h de
  // atendimento; SMS não tem esse requisito e pode ir direto para APROVADO.
  const status = parsed.data.channel === "WHATSAPP" ? "PENDENTE_APROVACAO" : "APROVADO";

  const template = await prisma.messageTemplate.create({
    data: { tenantId, ...parsed.data, status },
  });
  await logAudit({ tenantId, userId, action: "CREATE_TEMPLATE", target: "MessageTemplate", targetId: template.id });
  res.status(201).json(template);
});

const updateSchema = z.object({
  body: z.string().min(1).optional(),
  status: z.enum(["RASCUNHO", "PENDENTE_APROVACAO", "APROVADO", "REJEITADO"]).optional(),
  rejectionReason: z.string().optional(),
  providerTemplateId: z.string().optional(),
});

router.patch("/:id", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: userId } = req.user!;

  const template = await prisma.messageTemplate.findFirst({ where: { id: req.params.id, tenantId } });
  if (!template) return res.status(404).json({ error: "Template não encontrado" });

  // Editar o corpo de um template já aprovado exige nova aprovação (regra do provedor WhatsApp).
  const data: any = { ...parsed.data };
  if (parsed.data.body && template.channel === "WHATSAPP" && template.status === "APROVADO") {
    data.status = "PENDENTE_APROVACAO";
  }

  const updated = await prisma.messageTemplate.update({ where: { id: template.id }, data });
  await logAudit({ tenantId, userId, action: "UPDATE_TEMPLATE", target: "MessageTemplate", targetId: template.id, details: parsed.data });
  res.json(updated);
});

router.delete("/:id", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const { tenantId, id: userId } = req.user!;
  const template = await prisma.messageTemplate.findFirst({ where: { id: req.params.id, tenantId } });
  if (!template) return res.status(404).json({ error: "Template não encontrado" });
  await prisma.messageTemplate.delete({ where: { id: template.id } });
  await logAudit({ tenantId, userId, action: "DELETE_TEMPLATE", target: "MessageTemplate", targetId: template.id });
  res.status(204).send();
});

const previewSchema = z.object({
  sample: z.record(z.any()).default({ nome: "Maria Silva", cidade: "São Paulo", percentual: 45 }),
});

/** POST /api/templates/:id/preview — pré-visualização rica com placeholders substituídos. */
router.post("/:id/preview", async (req, res) => {
  const parsed = previewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const template = await prisma.messageTemplate.findFirst({ where: { id: req.params.id, tenantId: req.user!.tenantId } });
  if (!template) return res.status(404).json({ error: "Template não encontrado" });

  res.json({ rendered: renderTemplate(template.body, parsed.data.sample) });
});

export default router;

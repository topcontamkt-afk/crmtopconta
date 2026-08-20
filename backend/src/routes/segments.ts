import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { buildSegmentWhere } from "../services/segments";

const router = Router();
router.use(requireAuth);

router.get("/", async (req, res) => {
  const segments = await prisma.segmentDefinition.findMany({
    where: { tenantId: req.user!.tenantId },
    orderBy: { updatedAt: "desc" },
  });
  res.json(segments);
});

const filtersSchema = z.object({
  cidade: z.array(z.string()).optional(),
  faixaUso: z.array(z.string()).optional(),
  statusConta: z.array(z.string()).optional(),
  autorizacaoComunicacao: z.boolean().optional(),
  semUsoDiasMin: z.number().optional(),
  tags: z.array(z.string()).optional(),
  search: z.string().optional(),
});

/** POST /api/segments/preview — retorna a contagem de público sem salvar (usado no wizard). */
router.post("/preview", async (req, res) => {
  const parsed = filtersSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const where = buildSegmentWhere(req.user!.tenantId, parsed.data);
  const count = await prisma.client.count({ where });
  res.json({ count });
});

const createSchema = z.object({
  name: z.string().min(1),
  filters: filtersSchema,
  operator: z.enum(["AND", "OR"]).default("AND"),
});

router.post("/", requireRole("ADMIN", "OPERATOR", "ANALYST"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId } = req.user!;
  const where = buildSegmentWhere(tenantId, parsed.data.filters);
  const count = await prisma.client.count({ where });

  const segment = await prisma.segmentDefinition.create({
    data: { tenantId, name: parsed.data.name, filters: parsed.data.filters as any, operator: parsed.data.operator, lastCount: count },
  });
  res.status(201).json(segment);
});

router.delete("/:id", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const segment = await prisma.segmentDefinition.findFirst({ where: { id: req.params.id, tenantId: req.user!.tenantId } });
  if (!segment) return res.status(404).json({ error: "Segmento não encontrado" });
  await prisma.segmentDefinition.delete({ where: { id: segment.id } });
  res.status(204).send();
});

export default router;

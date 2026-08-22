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
  usadoNosUltimosDias: z.number().optional(),
  tags: z.array(z.string()).optional(),
  search: z.string().optional(),
  empresaConveniada: z.array(z.string()).optional(),
});

// Grupo de filtros combináveis (AND/OR aninhados) — segment builder avançado (Fase 2).
const groupSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    operator: z.enum(["AND", "OR"]).default("AND"),
    conditions: filtersSchema.optional(),
    groups: z.array(groupSchema).optional(),
  })
);

// Aceita tanto o formato simples (flat) quanto o avançado (grupo), para compatibilidade
// com o wizard de campanhas (Fase 1) e com o novo segment builder (Fase 2).
const filtersOrGroupSchema = z.union([groupSchema, filtersSchema]);

/** POST /api/segments/preview — retorna a contagem de público sem salvar (usado no wizard). */
router.post("/preview", async (req, res) => {
  const parsed = filtersOrGroupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const where = buildSegmentWhere(req.user!.tenantId, parsed.data as any);
  const count = await prisma.client.count({ where });
  res.json({ count });
});

const createSchema = z.object({
  name: z.string().min(1),
  filters: filtersOrGroupSchema,
  operator: z.enum(["AND", "OR"]).default("AND"),
  dynamic: z.boolean().default(true),
  refreshCron: z.string().default("0 * * * *"),
});

router.post("/", requireRole("ADMIN", "OPERATOR", "ANALYST"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId } = req.user!;
  const where = buildSegmentWhere(tenantId, parsed.data.filters as any);
  const count = await prisma.client.count({ where });

  const segment = await prisma.segmentDefinition.create({
    data: {
      tenantId,
      name: parsed.data.name,
      filters: parsed.data.filters as any,
      operator: parsed.data.operator,
      dynamic: parsed.data.dynamic,
      refreshCron: parsed.data.refreshCron,
      lastCount: count,
      lastRefreshedAt: new Date(),
    },
  });
  res.status(201).json(segment);
});

/** POST /api/segments/:id/refresh — recontagem manual (a automática roda via scheduler para segmentos dinâmicos). */
router.post("/:id/refresh", requireRole("ADMIN", "OPERATOR", "ANALYST"), async (req, res) => {
  const segment = await prisma.segmentDefinition.findFirst({ where: { id: req.params.id, tenantId: req.user!.tenantId } });
  if (!segment) return res.status(404).json({ error: "Segmento não encontrado" });

  const where = buildSegmentWhere(req.user!.tenantId, segment.filters as any);
  const count = await prisma.client.count({ where });
  const updated = await prisma.segmentDefinition.update({
    where: { id: segment.id },
    data: { lastCount: count, lastRefreshedAt: new Date() },
  });
  res.json(updated);
});

router.delete("/:id", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const segment = await prisma.segmentDefinition.findFirst({ where: { id: req.params.id, tenantId: req.user!.tenantId } });
  if (!segment) return res.status(404).json({ error: "Segmento não encontrado" });
  await prisma.segmentDefinition.delete({ where: { id: segment.id } });
  res.status(204).send();
});

export default router;

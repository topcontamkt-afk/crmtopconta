import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../middleware/audit";
import { buildSegmentWhere } from "../services/segments";
import { buildAudience, computeAttribution, enqueueCampaign, processQueueBatch } from "../services/campaignQueue";

const router = Router();
router.use(requireAuth);

router.get("/", async (req, res) => {
  const campaigns = await prisma.campaign.findMany({
    where: { tenantId: req.user!.tenantId },
    orderBy: { createdAt: "desc" },
    include: { segment: true },
  });
  res.json(campaigns);
});

router.get("/:id", async (req, res) => {
  const campaign = await prisma.campaign.findFirst({
    where: { id: req.params.id, tenantId: req.user!.tenantId },
    include: { segment: true },
  });
  if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });
  res.json(campaign);
});

/** Wizard de 5 passos consolidado em um único payload de criação. */
const createSchema = z.object({
  name: z.string().min(1),
  objective: z.string().optional(),
  channel: z.enum(["WHATSAPP", "SMS"]),
  segmentId: z.string().optional(),
  adHocFilters: z
    .object({
      cidade: z.array(z.string()).optional(),
      faixaUso: z.array(z.string()).optional(),
      statusConta: z.array(z.string()).optional(),
      autorizacaoComunicacao: z.boolean().optional(),
      semUsoDiasMin: z.number().optional(),
      tags: z.array(z.string()).optional(),
      search: z.string().optional(),
    })
    .optional(),
  messageTemplate: z.string().min(1),
  scheduledAt: z.string().datetime().optional(),
  throttlePerMin: z.number().int().positive().default(60),
  dedupeWindowHrs: z.number().int().positive().default(72),
  attributionDays: z.number().int().positive().default(7),
  costPerMessage: z.number().nonnegative().default(0),
});

router.post("/", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: userId } = req.user!;
  const d = parsed.data;

  // Passo de simulação: já calcula o público estimado (excluindo opt-outs) no momento da criação.
  const filters = d.segmentId
    ? (await prisma.segmentDefinition.findFirst({ where: { id: d.segmentId, tenantId } }))?.filters
    : d.adHocFilters;
  const where = buildSegmentWhere(tenantId, (filters as any) || {});
  const estimatedAudience = await prisma.client.count({
    where: { ...where, autorizacaoComunicacao: true, optOutAt: null, statusConta: { not: "BLOQUEADO" } },
  });

  const campaign = await prisma.campaign.create({
    data: {
      tenantId,
      name: d.name,
      objective: d.objective,
      channel: d.channel,
      segmentId: d.segmentId,
      adHocFilters: d.segmentId ? undefined : (d.adHocFilters as any),
      messageTemplate: d.messageTemplate,
      scheduledAt: d.scheduledAt ? new Date(d.scheduledAt) : undefined,
      throttlePerMin: d.throttlePerMin,
      dedupeWindowHrs: d.dedupeWindowHrs,
      attributionDays: d.attributionDays,
      costPerMessage: d.costPerMessage,
      audienceCount: estimatedAudience,
      status: "RASCUNHO",
    },
  });

  await logAudit({ tenantId, userId, action: "CREATE_CAMPAIGN", target: "Campaign", targetId: campaign.id, details: d });
  res.status(201).json(campaign);
});

/** GET /api/campaigns/:id/audience-preview — contagem de público em tempo real (para o wizard). */
router.get("/:id/audience-preview", async (req, res) => {
  const audience = await buildAudience(prisma, req.user!.tenantId, req.params.id);
  res.json({ count: audience.length });
});

/** POST /api/campaigns/:id/schedule — enfileira o público (aplica dedupe) e agenda o envio. */
router.post("/:id/schedule", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const { tenantId, id: userId } = req.user!;
  const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, tenantId } });
  if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });

  const result = await enqueueCampaign(prisma, tenantId, campaign.id);
  await logAudit({ tenantId, userId, action: "SCHEDULE_CAMPAIGN", target: "Campaign", targetId: campaign.id, details: result });
  res.json(result);
});

/** POST /api/campaigns/:id/dispatch — processa um lote da fila (chamado pelo worker/cron). */
router.post("/:id/dispatch", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, tenantId: req.user!.tenantId } });
  if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });
  const result = await processQueueBatch(prisma, campaign.id, Number(req.body?.limit) || 50);
  res.json(result);
});

/** GET /api/campaigns/:id/report — métricas de envio + conversão. */
router.get("/:id/report", async (req, res) => {
  const { tenantId } = req.user!;
  const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, tenantId } });
  if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });

  await computeAttribution(prisma, campaign.id);

  const grouped = await prisma.messageEvent.groupBy({
    by: ["status"],
    where: { campaignId: campaign.id },
    _count: true,
  });
  const conversions = await prisma.messageEvent.count({
    where: { campaignId: campaign.id, convertedAt: { not: null } },
  });
  const costAgg = await prisma.messageEvent.aggregate({
    where: { campaignId: campaign.id },
    _sum: { cost: true },
  });

  const enviados = grouped.reduce((acc, g) => acc + (g.status !== "FILA" && g.status !== "BLOQUEADO" ? g._count : 0), 0);

  res.json({
    campaignId: campaign.id,
    audienceCount: campaign.audienceCount,
    porStatus: grouped.map((g) => ({ status: g.status, count: g._count })),
    conversoes: conversions,
    taxaConversao: enviados ? ((conversions / enviados) * 100).toFixed(2) : "0.00",
    custoTotal: costAgg._sum.cost || 0,
    janelaAtribuicaoDias: campaign.attributionDays,
  });
});

export default router;

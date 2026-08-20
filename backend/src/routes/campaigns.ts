import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../middleware/audit";
import { buildSegmentWhere } from "../services/segments";
import {
  buildAudience,
  computeAttribution,
  enqueueCampaign,
  processQueueBatch,
  sendTestMessages,
} from "../services/campaignQueue";
import { computeABSignificance } from "../services/statistics";

const router = Router();
router.use(requireAuth);

router.get("/", async (req, res) => {
  const campaigns = await prisma.campaign.findMany({
    where: { tenantId: req.user!.tenantId },
    orderBy: { createdAt: "desc" },
    include: { segment: true, template: true },
  });
  res.json(campaigns);
});

router.get("/:id", async (req, res) => {
  const campaign = await prisma.campaign.findFirst({
    where: { id: req.params.id, tenantId: req.user!.tenantId },
    include: { segment: true, template: true },
  });
  if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });
  res.json(campaign);
});

const adHocFiltersSchema = z
  .object({
    cidade: z.array(z.string()).optional(),
    faixaUso: z.array(z.string()).optional(),
    statusConta: z.array(z.string()).optional(),
    autorizacaoComunicacao: z.boolean().optional(),
    semUsoDiasMin: z.number().optional(),
    tags: z.array(z.string()).optional(),
    search: z.string().optional(),
  })
  .passthrough(); // aceita também o formato de grupo AND/OR (Fase 2), validado no builder de segmentos

/** Wizard de 5 passos consolidado em um único payload de criação. */
const createSchema = z
  .object({
    name: z.string().min(1),
    objective: z.string().optional(),
    channel: z.enum(["WHATSAPP", "SMS"]),
    segmentId: z.string().optional(),
    adHocFilters: adHocFiltersSchema.optional(),
    templateId: z.string().optional(),
    messageTemplate: z.string().optional(), // texto livre — usado quando não há templateId
    messageTemplateB: z.string().optional(),
    variantSplitPercent: z.number().int().min(0).max(100).optional(),
    isSandbox: z.boolean().default(false),
    scheduledAt: z.string().datetime().optional(),
    throttlePerMin: z.number().int().positive().default(60),
    dedupeWindowHrs: z.number().int().positive().default(72),
    attributionDays: z.number().int().positive().default(7),
    costPerMessage: z.number().nonnegative().default(0),
  })
  .refine((d) => d.templateId || d.messageTemplate, {
    message: "Informe templateId (template aprovado) ou messageTemplate (texto livre)",
    path: ["messageTemplate"],
  });

router.post("/", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: userId } = req.user!;
  const d = parsed.data;

  let messageTemplate = d.messageTemplate || "";
  if (d.templateId) {
    const template = await prisma.messageTemplate.findFirst({ where: { id: d.templateId, tenantId } });
    if (!template) return res.status(404).json({ error: "Template não encontrado" });
    if (template.status !== "APROVADO" && !d.isSandbox) {
      return res.status(400).json({ error: "Template ainda não aprovado — use isSandbox=true para testar antes da aprovação" });
    }
    messageTemplate = template.body;
  }

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
      templateId: d.templateId,
      messageTemplate,
      messageTemplateB: d.messageTemplateB,
      variantSplitPercent: d.variantSplitPercent,
      isSandbox: d.isSandbox,
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

const testSendSchema = z.object({
  phones: z.array(z.string()).min(1).max(10),
});

/** POST /api/campaigns/:id/test-send — sandbox: envia a variante A para uma amostra pequena (QA). */
router.post("/:id/test-send", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const parsed = testSendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: userId } = req.user!;
  const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, tenantId } });
  if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });

  const result = await sendTestMessages(prisma, tenantId, campaign.id, parsed.data.phones);
  await logAudit({ tenantId, userId, action: "TEST_SEND_CAMPAIGN", target: "Campaign", targetId: campaign.id, details: { phones: parsed.data.phones } });
  res.json(result);
});

/** GET /api/campaigns/:id/report — métricas de envio, conversão, ROI e breakdown A/B. */
router.get("/:id/report", async (req, res) => {
  const { tenantId } = req.user!;
  const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, tenantId } });
  if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });

  await computeAttribution(prisma, campaign.id);

  const [grouped, conversions, costAgg, valueAgg, porVariante] = await Promise.all([
    prisma.messageEvent.groupBy({ by: ["status"], where: { campaignId: campaign.id }, _count: true }),
    prisma.messageEvent.count({ where: { campaignId: campaign.id, convertedAt: { not: null } } }),
    prisma.messageEvent.aggregate({ where: { campaignId: campaign.id }, _sum: { cost: true } }),
    prisma.messageEvent.aggregate({ where: { campaignId: campaign.id }, _sum: { convertedValue: true } }),
    campaign.variantSplitPercent
      ? prisma.messageEvent.groupBy({
          by: ["variant"],
          where: { campaignId: campaign.id, status: { not: "FILA" } },
          _count: true,
        })
      : Promise.resolve(null),
  ]);

  const enviados = grouped.reduce((acc, g) => acc + (g.status !== "FILA" && g.status !== "BLOQUEADO" ? g._count : 0), 0);
  const custoTotal = Number(costAgg._sum.cost || 0);
  const valorGerado = Number(valueAgg._sum.convertedValue || 0);

  let variantBreakdown = null;
  let abSignificance = null;
  if (porVariante) {
    const conversoesPorVariante = await prisma.messageEvent.groupBy({
      by: ["variant"],
      where: { campaignId: campaign.id, convertedAt: { not: null } },
      _count: true,
    });
    variantBreakdown = porVariante.map((v) => {
      const conv = conversoesPorVariante.find((c) => c.variant === v.variant)?._count || 0;
      return { variant: v.variant, enviados: v._count, conversoes: conv, taxaConversao: v._count ? ((conv / v._count) * 100).toFixed(2) : "0.00" };
    });

    // Significância estatística (Fase 3 — recorte leve): só calculável com as duas variantes.
    const a = porVariante.find((v) => v.variant === "A");
    const b = porVariante.find((v) => v.variant === "B");
    if (a && b) {
      const convA = conversoesPorVariante.find((c) => c.variant === "A")?._count || 0;
      const convB = conversoesPorVariante.find((c) => c.variant === "B")?._count || 0;
      const result = computeABSignificance(a._count, convA, b._count, convB);
      abSignificance = {
        ...result,
        pValue: result.pValue !== null ? Number(result.pValue.toFixed(4)) : null,
        zScore: result.zScore !== null ? Number(result.zScore.toFixed(3)) : null,
      };
    }
  }

  res.json({
    campaignId: campaign.id,
    isSandbox: campaign.isSandbox,
    audienceCount: campaign.audienceCount,
    porStatus: grouped.map((g) => ({ status: g.status, count: g._count })),
    conversoes: conversions,
    taxaConversao: enviados ? ((conversions / enviados) * 100).toFixed(2) : "0.00",
    custoTotal,
    valorGerado,
    roi: custoTotal > 0 ? (((valorGerado - custoTotal) / custoTotal) * 100).toFixed(2) : null,
    janelaAtribuicaoDias: campaign.attributionDays,
    variantBreakdown,
    abSignificance,
  });
});

/** GET /api/campaigns/:id/report/export.csv — export do relatório de envios (Fase 2). */
router.get("/:id/report/export.csv", requireRole("ADMIN", "OPERATOR", "ANALYST"), async (req, res) => {
  const { tenantId, id: userId } = req.user!;
  const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, tenantId } });
  if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });

  const events = await prisma.messageEvent.findMany({
    where: { campaignId: campaign.id },
    include: { client: { select: { nome: true, telefone: true, cidade: true } } },
    orderBy: { queuedAt: "asc" },
  });

  const header = "cliente,telefone,cidade,variante,status,provedor,custo,enviado_em,convertido_em,valor_convertido\n";
  const rows = events
    .map((e) =>
      [
        csvEscape(e.client.nome),
        e.client.telefone,
        csvEscape(e.client.cidade || ""),
        e.variant,
        e.status,
        e.provider || "",
        Number(e.cost),
        e.sentAt?.toISOString() || "",
        e.convertedAt?.toISOString() || "",
        e.convertedValue ? Number(e.convertedValue) : "",
      ].join(",")
    )
    .join("\n");

  await logAudit({ tenantId, userId, action: "EXPORT_CAMPAIGN_REPORT", target: "Campaign", targetId: campaign.id });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="campanha-${campaign.id}.csv"`);
  res.send(header + rows);
});

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export default router;

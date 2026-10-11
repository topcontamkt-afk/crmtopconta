import { breakdownByPerfil } from "../services/campaignPerfil";
import { classificarPerfil } from "../services/rendaPerfil";
import { ETAPAS_USO } from "../services/etapaUso";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../middleware/audit";
import { buildSegmentWhere, ENVIAVEL_WHERE } from "../services/segments";
import { PERFIS_RENDA } from "../services/rendaPerfil";
import {
  buildAudience,
  enqueueCampaign,
  processQueueBatch,
  sendTestMessages,
} from "../services/campaignQueue";
import { computeABSignificance } from "../services/statistics";
import {
  buildCampaignResults,
  liftAtDay,
  loadCampaignEvaluations,
  MAX_DAY,
  statsAtDay,
} from "../services/campaignResults";

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
    usadoNosUltimosDias: z.number().optional(),
    tags: z.array(z.string()).optional(),
    search: z.string().optional(),
    empresaConveniada: z.array(z.string()).optional(),
    perfilRenda: z.array(z.enum(PERFIS_RENDA)).optional(),
    noTetoLimite: z.boolean().optional(),
    saldoDisponivelMin: z.number().optional(),
    etapaUso: z.array(z.enum(ETAPAS_USO)).optional(),
    usosMin: z.number().int().min(0).optional(),
    usosMax: z.number().int().min(0).optional(),
    diasSemUsoRealMin: z.number().int().min(0).optional(),
    diasSemUsoRealMax: z.number().int().min(0).optional(),
    categoriasCompra: z.array(z.string()).optional(),
    lojistaIds: z.array(z.string()).optional(),
    compraNosUltimosDias: z.number().optional(),
    // Lista explícita de clientes (ex.: "aniversariantes do mês" montado no Dashboard) — o
    // wizard usa isso como um público alternativo a segmento salvo/filtros manuais.
    clientIds: z.array(z.string()).optional(),
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
    // Grupo de controle (opcional): % do público que NÃO recebe a mensagem, para medir o lift real.
    controlGroupPercent: z.number().int().min(0).max(50).optional(),
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
    where: { ...where, autorizacaoComunicacao: true, optOutAt: null, statusConta: { not: "BLOQUEADO" }, ...ENVIAVEL_WHERE },
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
      controlGroupPercent: d.controlGroupPercent || null,
      costPerMessage: d.costPerMessage,
      audienceCount: estimatedAudience,
      status: "RASCUNHO",
    },
  });

  // Não loga `d` bruto: adHocFilters.search é busca livre por nome/telefone (ver
  // services/segments.ts buildSegmentWhere) — um operador pode digitar o nome ou telefone
  // exato de um cliente ali para montar um público ad hoc, o que gravaria PII no AuditLog.
  // messageTemplate/messageTemplateB também ficam de fora (conteúdo de mensagem, não
  // metadado da campanha). Só o que descreve a configuração da campanha em si é logado.
  await logAudit({
    tenantId,
    userId,
    action: "CREATE_CAMPAIGN",
    target: "Campaign",
    targetId: campaign.id,
    details: {
      name: d.name,
      channel: d.channel,
      segmentId: d.segmentId,
      hasAdHocFilters: !!d.adHocFilters,
      templateId: d.templateId,
      usesFreeTextMessage: !d.templateId,
      isSandbox: d.isSandbox,
      scheduledAt: d.scheduledAt,
      throttlePerMin: d.throttlePerMin,
      dedupeWindowHrs: d.dedupeWindowHrs,
      attributionDays: d.attributionDays,
      controlGroupPercent: d.controlGroupPercent,
      costPerMessage: d.costPerMessage,
      estimatedAudience,
    },
  });
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
  // Loga só a quantidade, nunca os números de telefone em si — não são deriváveis de um
  // Client existente (é um envio de teste ad hoc do operador), então não têm targetId para o
  // cascade de anonimização do retention.ts alcançar depois; a única defesa é não gravar.
  await logAudit({
    tenantId,
    userId,
    action: "TEST_SEND_CAMPAIGN",
    target: "Campaign",
    targetId: campaign.id,
    details: { phoneCount: parsed.data.phones.length },
  });
  res.json(result);
});

/**
 * GET /api/campaigns/:id/report — resultado pelo USO REAL do cliente (transações): curva de
 * conversão D0 a D30, separação de quem tinha saldo no envio, grupo de controle (se houver),
 * lucro (Juros) e ROI. Calculado na hora, sem estado guardado — ver services/campaignResults.ts.
 */
router.get("/:id/report", async (req, res) => {
  const { tenantId } = req.user!;
  const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, tenantId } });
  if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });

  const [grouped, costAgg, evals] = await Promise.all([
    prisma.messageEvent.groupBy({ by: ["status"], where: { campaignId: campaign.id }, _count: true }),
    prisma.messageEvent.aggregate({ where: { campaignId: campaign.id }, _sum: { cost: true } }),
    loadCampaignEvaluations(prisma, tenantId, campaign.id),
  ]);

  const treated = evals.filter((e) => e.cohort === "TRATADO");
  const control = evals.filter((e) => e.cohort === "CONTROLE");
  const resultados = buildCampaignResults(evals);

  // Janela de cabeçalho = a configurada na campanha (limitada a 30 dias); a curva completa vem em `resultados`.
  const janelaDias = Math.min(campaign.attributionDays, MAX_DAY);
  const headline = statsAtDay(treated, janelaDias);
  const custoTotal = Number(costAgg._sum.cost || 0);
  const lucro = headline.lucro;
  const incremental = control.length > 0 ? liftAtDay(treated, control, janelaDias) : null;

  let variantBreakdown = null;
  let abSignificance = null;
  if (campaign.variantSplitPercent) {
    const byVariant = new Map<string, typeof treated>();
    for (const e of treated) byVariant.set(e.variant, [...(byVariant.get(e.variant) ?? []), e]);
    variantBreakdown = [...byVariant.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([variant, list]) => {
        const st = statsAtDay(list, janelaDias);
        return { variant, enviados: st.n, conversoes: st.convertidos, taxaConversao: (st.taxa * 100).toFixed(2) };
      });

    // Significância estatística (Fase 3 — recorte leve): só calculável com as duas variantes.
    const a = variantBreakdown.find((v) => v.variant === "A");
    const b = variantBreakdown.find((v) => v.variant === "B");
    if (a && b) {
      const result = computeABSignificance(a.enviados, a.conversoes, b.enviados, b.conversoes);
      abSignificance = {
        ...result,
        pValue: result.pValue !== null ? Number(result.pValue.toFixed(4)) : null,
        zScore: result.zScore !== null ? Number(result.zScore.toFixed(3)) : null,
      };
    }
  }

  // Lista nominal (os 50 usos mais recentes): só nome e cidade — telefone e documento ficam no CSV.
  const users = treated
    .filter((e) => e.usos.length > 0)
    .sort((a, b) => b.usos[0].confirmedAt.getTime() - a.usos[0].confirmedAt.getTime())
    .slice(0, 50);
  const clients = users.length
    ? await prisma.client.findMany({
        where: { tenantId, id: { in: users.map((u) => u.clientId) } },
        select: { id: true, nome: true, cidade: true },
      })
    : [];
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const usuarios = users.map((e) => ({
    nome: clientById.get(e.clientId)?.nome ?? "—",
    cidade: clientById.get(e.clientId)?.cidade ?? null,
    grupoSaldo: e.grupoSaldo,
    primeiroUsoEm: e.usos[0].confirmedAt.toISOString(),
    diaPrimeiroUso: e.usos[0].dayOffset,
    usos: e.usos.slice(0, 5).map((u) => ({
      tipo: u.kind,
      valor: u.valorPrincipal,
      lucro: u.kind === "ANTECIPACAO" ? u.juros : null,
      em: u.confirmedAt.toISOString(),
    })),
    valorMovimentado: Number(e.usos.reduce((acc, u) => acc + u.valorPrincipal, 0).toFixed(2)),
  }));

  // Quebra por perfil de renda (PF1–PF4) pelo limite atual dos clientes do envio.
  const limites = new Map<string, number>();
  const idsAvaliados = [...new Set(evals.map((e) => e.clientId))];
  for (let i = 0; i < idsAvaliados.length; i += 5000) {
    const rows = await prisma.client.findMany({
      where: { tenantId, id: { in: idsAvaliados.slice(i, i + 5000) } },
      select: { id: true, limiteTotal: true },
    });
    for (const r of rows) limites.set(r.id, Number(r.limiteTotal));
  }
  const porPerfil = breakdownByPerfil(treated, control, (id) => classificarPerfil(limites.get(id)), janelaDias).map((p) => ({
    ...p,
    taxaConversao: (p.taxa * 100).toFixed(2),
  }));

  res.json({
    campaignId: campaign.id,
    porPerfil,
    isSandbox: campaign.isSandbox,
    audienceCount: campaign.audienceCount,
    porStatus: grouped.map((g) => ({ status: g.status, count: g._count })),
    // Campos de cabeçalho (mesmos nomes de antes): agora medidos por uso real, sobre quem de fato recebeu.
    conversoes: headline.convertidos,
    taxaConversao: (headline.taxa * 100).toFixed(2),
    custoTotal,
    valorMovimentado: headline.valorMovimentado,
    // Lucro = Juros das antecipações (compra à vista não tem lucro conhecido: taxa do comerciante).
    valorGerado: lucro,
    roi: custoTotal > 0 ? (((lucro - custoTotal) / custoTotal) * 100).toFixed(2) : null,
    lucroIncremental: incremental?.lucroIncremental ?? null,
    roiIncremental:
      incremental && custoTotal > 0 ? (((incremental.lucroIncremental - custoTotal) / custoTotal) * 100).toFixed(2) : null,
    janelaAtribuicaoDias: janelaDias,
    controleEnviados: control.length,
    resultados,
    usuarios,
    variantBreakdown,
    abSignificance,
  });
});

/**
 * GET /api/campaigns/:id/report/export.csv — lista nominal de envios com o uso de cada cliente
 * (saldo no envio, primeiro uso, uso por horizonte D0..D30, valor e lucro em 30 dias).
 */
router.get("/:id/report/export.csv", requireRole("ADMIN", "OPERATOR", "ANALYST"), async (req, res) => {
  const { tenantId, id: userId } = req.user!;
  const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, tenantId } });
  if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });

  const [events, evals] = await Promise.all([
    prisma.messageEvent.findMany({
      where: { campaignId: campaign.id },
      include: { client: { select: { nome: true, telefone: true, cidade: true } } },
      orderBy: { queuedAt: "asc" },
    }),
    loadCampaignEvaluations(prisma, tenantId, campaign.id),
  ]);
  const evalById = new Map(evals.map((e) => [e.id, e]));

  const horizons = [0, 1, 3, 7, 14, 30];
  const header =
    [
      "cliente", "telefone", "cidade", "grupo", "variante", "status", "provedor", "custo", "enviado_em",
      "saldo_no_envio", "situacao_saldo", "primeiro_uso_em", "dia_do_primeiro_uso",
      ...horizons.map((h) => `usou_ate_d${h}`),
      "qtd_usos_30d", "valor_movimentado_30d", "lucro_30d",
    ].join(",") + "\n";

  const rows = events
    .map((e) => {
      const ev = evalById.get(e.id);
      const usos = ev?.usos ?? [];
      return [
        csvEscape(e.client.nome),
        e.client.telefone,
        csvEscape(e.client.cidade || ""),
        e.status === "CONTROLE" ? "CONTROLE" : "TRATADO",
        e.variant,
        e.status,
        e.provider || "",
        Number(e.cost),
        e.sentAt?.toISOString() || "",
        ev?.saldoNoEnvio ?? "",
        ev?.grupoSaldo ?? "",
        usos[0]?.confirmedAt.toISOString() ?? "",
        usos[0]?.dayOffset ?? "",
        ...horizons.map((h) => (ev ? (usos.some((u) => u.dayOffset <= h) ? "sim" : "nao") : "")),
        ev ? usos.length : "",
        ev ? Number(usos.reduce((acc, u) => acc + u.valorPrincipal, 0).toFixed(2)) : "",
        ev ? Number(usos.reduce((acc, u) => acc + (u.kind === "ANTECIPACAO" ? u.juros : 0), 0).toFixed(2)) : "",
      ].join(",");
    })
    .join("\n");

  await logAudit({ tenantId, userId, action: "EXPORT_CAMPAIGN_REPORT", target: "Campaign", targetId: campaign.id });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="campanha-${campaign.id}.csv"`);
  res.send(header + rows);
});

function csvEscape(value: string): string {
  // Neutraliza CSV/formula injection (mesmo tratamento de routes/clients.ts): nome/cidade vêm de
  // importação e, começando com =/+/-/@, virariam fórmula executável no Excel/Sheets.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (safe.includes(",") || safe.includes('"') || safe.includes("\n")) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export default router;

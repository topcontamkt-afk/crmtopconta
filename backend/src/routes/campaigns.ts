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
import { linkRecipients, prepareManual } from "../services/manualCampaign";
import { validateWizard } from "../services/campaignWizard";
import { costConfigFrom, DEFAULT_COSTS } from "../services/messageCost";
import { maskPhone } from "../services/masking";
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


/* ───────────────────────── campanha manual (lista de planilha) ───────────────────────── */

const MAX_MANUAL_ROWS = 5000;
const manualRowsSchema = z
  .array(z.object({ nome: z.any(), telefone: z.any(), cpf: z.any().optional(), limiteDisponivel: z.any().optional() }))
  .min(1)
  .max(MAX_MANUAL_ROWS);

const manualPreviewSchema = z.object({ templateId: z.string(), rows: manualRowsSchema });

/** POST /api/campaigns/manual/preview — confere a lista sem gravar nada. */
router.post("/manual/preview", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const parsed = manualPreviewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const r = await prepareManual(prisma, req.user!.tenantId, parsed.data.rows, parsed.data.templateId);
  if ("error" in r) return res.status(400).json({ error: r.error });
  res.json({
    total: parsed.data.rows.length,
    enviar: r.enviar.length,
    daBase: r.daBase,
    foraDaBase: r.enviar.length - r.daBase,
    recusadas: r.rejected.length,
    motivos: r.rejected.slice(0, 200),
  });
});

const manualCreateSchema = z.object({
  name: z.string().min(1),
  objective: z.string().optional(),
  templateId: z.string(),
  rows: manualRowsSchema,
  throttlePerMin: z.number().int().positive().default(60),
  costPerMessage: z.number().nonnegative().default(0),
  // Aceite obrigatório: quem sobe a lista responde por ter autorização para contatar os números.
  consentimento: z.literal(true),
  // Rascunho: guarda a lista e a campanha sem enfileirar nada (o envio sai ao agendar/lançar).
  rascunho: z.boolean().default(false),
  scheduledAt: z.string().datetime().optional(),
});

/**
 * POST /api/campaigns/manual — cria a campanha com a lista e já enfileira os envios (status FILA).
 * O disparo é o mesmo das outras campanhas ("Disparar lote" / cron). Os contatos ficam guardados
 * (CampaignRecipient) para a análise depois.
 */
router.post("/manual", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const parsed = manualCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: userId } = req.user!;
  const d = parsed.data;

  const r = await prepareManual(prisma, tenantId, d.rows, d.templateId);
  if ("error" in r) return res.status(400).json({ error: r.error });
  if (r.enviar.length === 0) return res.status(400).json({ error: "Nenhum contato da lista pode receber a mensagem", motivos: r.rejected.slice(0, 200) });

  const campaign = await prisma.campaign.create({
    data: {
      tenantId,
      name: d.name,
      objective: d.objective,
      channel: "WHATSAPP",
      manual: true,
      templateId: r.template.id,
      messageTemplate: r.template.body,
      throttlePerMin: d.throttlePerMin,
      dedupeWindowHrs: 1,
      attributionDays: 30,
      costPerMessage: d.costPerMessage,
      audienceCount: r.enviar.length,
      scheduledAt: d.scheduledAt ? new Date(d.scheduledAt) : undefined,
      status: d.rascunho ? "RASCUNHO" : "AGENDADA",
    },
  });

  for (let i = 0; i < r.enviar.length; i += 500) {
    const part = r.enviar.slice(i, i + 500);
    await prisma.campaignRecipient.createMany({
      data: part.map((m) => ({
        tenantId,
        campaignId: campaign.id,
        nome: m.nome,
        telefone: m.telefone,
        cpfHash: m.cpfHash,
        cpfMasked: m.cpfMasked,
        limiteDisponivel: m.limiteDisponivel,
        clientId: m.clientId,
      })),
    });
  }
  const saved = d.rascunho ? [] : await prisma.campaignRecipient.findMany({ where: { tenantId, campaignId: campaign.id }, select: { id: true, clientId: true } });
  for (let i = 0; i < saved.length; i += 500) {
    await prisma.messageEvent.createMany({
      data: saved.slice(i, i + 500).map((rec) => ({ campaignId: campaign.id, clientId: rec.clientId, recipientId: rec.id, channel: "WHATSAPP" as const, status: "FILA" as const })),
    });
  }

  // Só contagens no log: nome, telefone e CPF da lista não vão para o AuditLog.
  await logAudit({
    tenantId,
    userId,
    action: "CREATE_MANUAL_CAMPAIGN",
    target: "Campaign",
    targetId: campaign.id,
    details: { templateId: r.template.id, recebem: r.enviar.length, daBase: r.daBase, recusadas: r.rejected.length, consentimento: true },
  });
  res.status(201).json({ campaign, enviar: r.enviar.length, daBase: r.daBase, recusadas: r.rejected.length, motivos: r.rejected.slice(0, 200) });
});

/**
 * GET /api/campaigns/:id/destinatarios — quem entrou na lista manual, o que aconteceu com cada envio
 * e, para quem é cliente da base, se usou o limite e quantos dias depois do envio.
 */
router.get("/:id/destinatarios", async (req, res) => {
  const { tenantId } = req.user!;
  const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, tenantId } });
  if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });

  await linkRecipients(prisma, tenantId, campaign.id); // contatos que entraram na base depois do envio
  const [recipients, evals] = await Promise.all([
    prisma.campaignRecipient.findMany({
      where: { tenantId, campaignId: campaign.id },
      include: { messageEvents: { select: { id: true, status: true, sentAt: true, error: true } } },
      orderBy: { nome: "asc" },
    }),
    loadCampaignEvaluations(prisma, tenantId, campaign.id),
  ]);
  const evalById = new Map(evals.map((e) => [e.id, e]));

  const rows = recipients.map((rec) => {
    const evt = rec.messageEvents[0];
    const ev = evt ? evalById.get(evt.id) : undefined;
    const first = ev?.usos[0];
    return {
      id: rec.id,
      nome: rec.nome,
      telefone: maskPhone(rec.telefone),
      naBase: !!rec.clientId,
      limiteDisponivel: rec.limiteDisponivel === null ? null : Number(rec.limiteDisponivel),
      status: evt?.status ?? null,
      erro: evt?.error ?? null,
      enviadoEm: evt?.sentAt?.toISOString() ?? null,
      // null com naBase=true e enviado = ainda não usou (na janela de 30 dias)
      usou: ev ? ev.usos.length > 0 : null,
      diasAteUso: first ? first.dayOffset : null,
      primeiroUsoEm: first ? first.confirmedAt.toISOString() : null,
      valorMovimentado: ev ? Number(ev.usos.reduce((a, u) => a + u.valorPrincipal, 0).toFixed(2)) : null,
    };
  });
  const medidos = rows.filter((r) => r.naBase && r.enviadoEm);
  res.json({
    total: rows.length,
    naBase: rows.filter((r) => r.naBase).length,
    foraDaBase: rows.filter((r) => !r.naBase).length,
    medidos: medidos.length,
    usaram: medidos.filter((r) => r.usou).length,
    destinatarios: rows,
  });
});


/* ───────────────────────── assistente: validação e custos ───────────────────────── */

const wizardSchema = z.object({
  templateId: z.string(),
  scheduledAt: z.string().datetime().nullish(),
  audience: z.discriminatedUnion("tipo", [
    z.object({ tipo: z.literal("todos") }),
    z.object({ tipo: z.literal("segmento"), segmentId: z.string() }),
    z.object({ tipo: z.literal("filtros"), filters: z.record(z.any()) }),
    z.object({ tipo: z.literal("lista"), clientIds: z.array(z.string()).min(1).max(100_000) }),
    z.object({ tipo: z.literal("planilha"), rows: manualRowsSchema }),
  ]),
});

/** POST /api/campaigns/wizard/validar — confere tudo antes de lançar (só lê, não grava nada). */
router.post("/wizard/validar", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const parsed = wizardSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.json(await validateWizard(prisma, req.user!.tenantId, parsed.data as any));
});

/** GET /api/campaigns/custos — custo por mensagem usado na estimativa (padrão ou o configurado). */
router.get("/custos", async (req, res) => {
  const t = await prisma.tenant.findUniqueOrThrow({ where: { id: req.user!.tenantId }, select: { custoMarketingUsd: true, custoUtilidadeUsd: true, cambioUsdBrl: true } });
  res.json({ ...costConfigFrom(t), padrao: DEFAULT_COSTS });
});

const custosSchema = z.object({
  marketingUsd: z.number().min(0).max(10).nullable(),
  utilidadeUsd: z.number().min(0).max(10).nullable(),
  cambioUsdBrl: z.number().gt(0).max(100),
});

/** PUT /api/campaigns/custos — ajusta a tabela de preços e o câmbio da estimativa (só ADMIN). */
router.put("/custos", requireRole("ADMIN"), async (req, res) => {
  const parsed = custosSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: userId } = req.user!;
  const t = await prisma.tenant.update({
    where: { id: tenantId },
    data: { custoMarketingUsd: parsed.data.marketingUsd, custoUtilidadeUsd: parsed.data.utilidadeUsd, cambioUsdBrl: parsed.data.cambioUsdBrl },
    select: { custoMarketingUsd: true, custoUtilidadeUsd: true, cambioUsdBrl: true },
  });
  await logAudit({ tenantId, userId, action: "UPDATE_MESSAGE_COSTS", target: "Tenant", targetId: tenantId, details: parsed.data });
  res.json({ ...costConfigFrom(t), padrao: DEFAULT_COSTS });
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

  if (campaign.manual) await linkRecipients(prisma, tenantId, campaign.id);
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
    manual: campaign.manual,
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

  if (campaign.manual) await linkRecipients(prisma, tenantId, campaign.id);
  const [events, evals] = await Promise.all([
    prisma.messageEvent.findMany({
      where: { campaignId: campaign.id },
      include: { client: { select: { nome: true, telefone: true, cidade: true } }, recipient: { select: { nome: true, telefone: true } } },
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
        csvEscape(e.client?.nome ?? e.recipient?.nome ?? ""),
        e.client?.telefone ?? e.recipient?.telefone ?? "",
        csvEscape(e.client?.cidade || ""),
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

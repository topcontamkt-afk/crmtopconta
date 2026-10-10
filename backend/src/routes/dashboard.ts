import { ETAPA_CASE_SQL } from "../services/etapaUso";
import { ENVIAVEL_WHERE } from "../services/segments";
import { LIMITE_MAXIMO, LIMITE_TETO, PERFIL_LABELS, PERFIS_RENDA, estimarSalario } from "../services/rendaPerfil";
import { Router } from "express";
import { z } from "zod";
import { prisma, tenantRaw } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { FAIXA_LABELS } from "../services/usage";
import { addDays, clientWhere, computeKpis, DashboardFilters, rawFilterSql, todayBrt } from "../services/dashboardMetrics";
import { computeHealth } from "../services/health";
import { ensureTodaySnapshot } from "../services/snapshots";
import { computeOpportunities, OPPORTUNITY_KEYS, OpportunityKey, opportunityAudience, suggestedMessage } from "../services/opportunities";

const router = Router();
router.use(requireAuth);

interface RankingRow {
  chave: string;
  count: number;
  ativos: number;
  valorUtilizado: number;
}

/**
 * Ranking genérico (clientes, ativos, valor utilizado) agrupado por uma coluna de texto do
 * Client — hoje usado para "cidade" e "empresaConveniada" (secretarias/convênios). SQL raw
 * porque o groupBy do Prisma não soma/conta sob uma condição (statusConta='ATIVO') dentro do
 * mesmo agrupamento. `column` nunca vem de entrada do usuário (é um literal fixo no código),
 * então interpolar o nome da coluna no texto do SQL é seguro.
 */
async function rankingPorCampo(tenantId: string, column: "cidade" | "empresaConveniada"): Promise<RankingRow[]> {
  const rows = await tenantRaw.query<
    Array<{ chave: string; total: bigint; ativos: bigint; valor_utilizado: number | null }>
  >(
    `SELECT "${column}" AS chave,
            COUNT(*)::bigint AS total,
            COUNT(*) FILTER (WHERE "statusConta" = 'ATIVO')::bigint AS ativos,
            COALESCE(SUM("valorUtilizado"), 0)::float AS valor_utilizado
     FROM "Client"
     WHERE "tenantId" = $1 AND "${column}" IS NOT NULL
     GROUP BY "${column}"
     ORDER BY total DESC
     LIMIT 10`,
    tenantId
  );
  return rows.map((r) => ({
    chave: r.chave,
    count: Number(r.total),
    ativos: Number(r.ativos),
    valorUtilizado: r.valor_utilizado || 0,
  }));
}

/** GET /api/dashboard/summary — KPIs principais descritos no PRD. */
router.get("/summary", async (req, res) => {
  const { tenantId } = req.user!;
  const days = Number(req.query.days) || 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [
    totalClientes,
    novosClientes,
    ativos,
    inativos,
    porFaixaRaw,
    agregados,
    semUso,
    lastImport,
    rankingCidades,
    rankingSecretarias,
  ] = await Promise.all([
    prisma.client.count({ where: { tenantId } }),
    prisma.client.count({ where: { tenantId, createdAt: { gte: since } } }),
    prisma.client.count({ where: { tenantId, statusConta: "ATIVO" } }),
    prisma.client.count({ where: { tenantId, statusConta: "INATIVO" } }),
    prisma.client.groupBy({ by: ["faixaUso"], where: { tenantId }, _count: true }),
    prisma.client.aggregate({
      where: { tenantId },
      _sum: { limiteTotal: true, valorUtilizado: true, saldoDisponivel: true },
      _avg: { valorUtilizado: true },
    }),
    prisma.client.count({ where: { tenantId, faixaUso: "SEM_USO" } }),
    prisma.importJob.findFirst({ where: { tenantId }, orderBy: { startedAt: "desc" } }),
    rankingPorCampo(tenantId, "cidade"),
    // Ranking de "secretarias" (empresa conveniada / convênio de folha) que mais usam o app —
    // só populado para clientes importados pelo formato "Cartões e contas"/"SaldoCartao".
    rankingPorCampo(tenantId, "empresaConveniada"),
  ]);

  const porFaixa = porFaixaRaw.map((f) => ({
    faixa: f.faixaUso,
    label: FAIXA_LABELS[f.faixaUso as keyof typeof FAIXA_LABELS],
    count: f._count,
  }));

  const limiteCompleto = porFaixaRaw.find((f) => f.faixaUso === "USO_100")?._count || 0;

  res.json({
    totalClientes,
    novosClientes,
    ativos,
    inativos,
    porFaixa,
    ranking_cidades: rankingCidades.map((r) => ({ cidade: r.chave, count: r.count, ativos: r.ativos, valorUtilizado: r.valorUtilizado })),
    ranking_secretarias: rankingSecretarias.map((r) => ({ empresaConveniada: r.chave, count: r.count, ativos: r.ativos, valorUtilizado: r.valorUtilizado })),
    limiteTotalLiberado: agregados._sum.limiteTotal || 0,
    valorUtilizadoTotal: agregados._sum.valorUtilizado || 0,
    saldoDisponivelTotal: agregados._sum.saldoDisponivel || 0,
    ticketMedio: agregados._avg.valorUtilizado || 0,
    percentualClientes100: totalClientes ? ((limiteCompleto / totalClientes) * 100).toFixed(2) : "0.00",
    clientesSemUso: semUso,
    ultimaAtualizacao: lastImport?.finishedAt || lastImport?.startedAt || null,
  });
});

/**
 * GET /api/dashboard/uso-mensal — taxa de uso do limite pela base de clientes, mês a mês.
 *
 * Definição: para cada cliente, `dataUltimaUtilizacao` guarda apenas a data da última
 * utilização (a planilha de origem não traz histórico completo de uso, só o snapshot mais
 * recente — ver importService.ts). Por isso a "taxa de uso do mês" aqui é: dos clientes da
 * base hoje, quantos % tiveram sua ÚLTIMA utilização registrada dentro daquele mês. É uma boa
 * aproximação de atividade mensal (mês corrente = "usou este mês"), mas não captura clientes
 * que usaram mais de uma vez no período — para isso seria necessário um histórico de
 * transações (Movement), que hoje só é populado para renovação de limite.
 */
router.get("/uso-mensal", async (req, res) => {
  const { tenantId } = req.user!;

  const [totalClientes, porMesRaw] = await Promise.all([
    prisma.client.count({ where: { tenantId } }),
    tenantRaw.query<Array<{ mes: Date; usados: bigint }>>(
      `SELECT date_trunc('month', "dataUltimaUtilizacao") AS mes, COUNT(*)::bigint AS usados
       FROM "Client"
       WHERE "tenantId" = $1
         AND "dataUltimaUtilizacao" IS NOT NULL
         AND "dataUltimaUtilizacao" >= date_trunc('month', now()) - interval '11 months'
       GROUP BY mes ORDER BY mes ASC`,
      tenantId
    ),
  ]);

  const usadosPorMes = new Map<string, number>();
  for (const row of porMesRaw) {
    usadosPorMes.set(row.mes.toISOString().slice(0, 7), Number(row.usados));
  }

  const meses: Array<{ mes: string; label: string; usados: number; percent: number }> = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = d.toISOString().slice(0, 7);
    const usados = usadosPorMes.get(key) || 0;
    meses.push({
      mes: key,
      label: d.toLocaleDateString("pt-BR", { month: "short", year: "2-digit", timeZone: "UTC" }),
      usados,
      percent: totalClientes ? Number(((usados / totalClientes) * 100).toFixed(1)) : 0,
    });
  }

  res.json({ totalClientes, taxaMesAtual: meses[meses.length - 1]?.percent ?? 0, meses });
});

/**
 * GET /api/dashboard/encerramentos — taxa de encerramento/cancelamento de conta, mês a mês
 * (últimos 12 meses), espelhando /uso-mensal: % da base atual cujo `encerradoEm` caiu em cada
 * mês, mais os motivos de encerramento mais comuns no período. Só populado para clientes
 * importados pelo formato "Cartões e contas"/"SaldoCartao" (`encerradoEm`/`motivoEncerramento`
 * — ver cardAccountImport.ts); planilhas no formato genérico não têm esse dado.
 */
router.get("/encerramentos", async (req, res) => {
  const { tenantId } = req.user!;

  const [totalClientes, porMesRaw, motivosRaw] = await Promise.all([
    prisma.client.count({ where: { tenantId } }),
    tenantRaw.query<Array<{ mes: Date; encerrados: bigint }>>(
      `SELECT date_trunc('month', "encerradoEm") AS mes, COUNT(*)::bigint AS encerrados
       FROM "Client"
       WHERE "tenantId" = $1
         AND "encerradoEm" IS NOT NULL
         AND "encerradoEm" >= date_trunc('month', now()) - interval '11 months'
       GROUP BY mes ORDER BY mes ASC`,
      tenantId
    ),
    prisma.client.groupBy({
      by: ["motivoEncerramento"],
      where: { tenantId, encerradoEm: { not: null }, motivoEncerramento: { not: null } },
      _count: true,
      orderBy: { _count: { motivoEncerramento: "desc" } },
      take: 5,
    }),
  ]);

  const encerradosPorMes = new Map<string, number>();
  for (const row of porMesRaw) {
    encerradosPorMes.set(row.mes.toISOString().slice(0, 7), Number(row.encerrados));
  }

  const meses: Array<{ mes: string; label: string; encerrados: number; percent: number }> = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = d.toISOString().slice(0, 7);
    const encerrados = encerradosPorMes.get(key) || 0;
    meses.push({
      mes: key,
      label: d.toLocaleDateString("pt-BR", { month: "short", year: "2-digit", timeZone: "UTC" }),
      encerrados,
      percent: totalClientes ? Number(((encerrados / totalClientes) * 100).toFixed(1)) : 0,
    });
  }

  res.json({
    totalClientes,
    taxaMesAtual: meses[meses.length - 1]?.percent ?? 0,
    meses,
    motivos: motivosRaw.map((m) => ({ motivo: m.motivoEncerramento as string, count: m._count })),
  });
});

/**
 * GET /api/dashboard/engajamento — níveis de engajamento de uso do recurso (cartão/limite) +
 * aniversariantes do mês corrente, pensado para alimentar disparo de campanhas de reengajamento.
 *
 * Nível de engajamento (distinto da faixa de uso já existente — aqui é uma leitura mais
 * "de negócio", cruzando status da conta com % de uso): Bloqueado e Sem engajamento (inativo ou
 * ativo sem nenhum uso) sempre têm prioridade; entre os ativos com uso, 3 faixas (baixo/moderado/
 * alto), no mesmo corte de "uso intermediário" já usado em usage.ts (20% e 70%).
 */
router.get("/engajamento", async (req, res) => {
  const { tenantId } = req.user!;

  const [niveisRaw, totalAniversariantes, aniversariantesRaw] = await Promise.all([
    tenantRaw.query<Array<{ nivel: string; count: bigint }>>(
      `SELECT
         CASE
           WHEN "statusConta" = 'BLOQUEADO' THEN 'bloqueado'
           WHEN "statusConta" = 'INATIVO' THEN 'sem_engajamento'
           WHEN "percentualUtilizado" >= 70 THEN 'alto'
           WHEN "percentualUtilizado" >= 20 THEN 'moderado'
           WHEN "percentualUtilizado" > 0 THEN 'baixo'
           ELSE 'sem_engajamento'
         END AS nivel,
         COUNT(*)::bigint AS count
       FROM "Client"
       WHERE "tenantId" = $1
       GROUP BY nivel`,
      tenantId
    ),
    tenantRaw.query<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM "Client"
       WHERE "tenantId" = $1 AND "dataNascimento" IS NOT NULL
         AND EXTRACT(MONTH FROM "dataNascimento") = EXTRACT(MONTH FROM CURRENT_DATE)`,
      tenantId
    ),
    tenantRaw.query<
      Array<{ id: string; nome: string; telefone: string; cidade: string | null; dia: number }>
    >(
      `SELECT "id", "nome", "telefone", "cidade", EXTRACT(DAY FROM "dataNascimento")::int AS dia
       FROM "Client"
       WHERE "tenantId" = $1 AND "dataNascimento" IS NOT NULL
         AND EXTRACT(MONTH FROM "dataNascimento") = EXTRACT(MONTH FROM CURRENT_DATE)
       ORDER BY dia ASC
       LIMIT 100`,
      tenantId
    ),
  ]);

  const NIVEL_LABELS: Record<string, string> = {
    sem_engajamento: "Sem engajamento",
    baixo: "Baixo engajamento",
    moderado: "Engajamento moderado",
    alto: "Alto engajamento",
    bloqueado: "Bloqueado",
  };
  const NIVEL_ORDER = ["sem_engajamento", "baixo", "moderado", "alto", "bloqueado"];

  const contagem = new Map(niveisRaw.map((n) => [n.nivel, Number(n.count)]));
  const niveis = NIVEL_ORDER.map((nivel) => ({
    nivel,
    label: NIVEL_LABELS[nivel],
    count: contagem.get(nivel) || 0,
  }));

  res.json({
    niveis,
    aniversariantes: {
      mesLabel: new Date().toLocaleDateString("pt-BR", { month: "long", year: "numeric" }),
      total: Number(totalAniversariantes[0]?.count || 0),
      itens: aniversariantesRaw.map((a) => ({ id: a.id, nome: a.nome, telefone: a.telefone, cidade: a.cidade, dia: a.dia })),
    },
  });
});

/**
 * GET /api/dashboard/perfil — perfil demográfico (faixa etária, sexo) e financeiro (faixa de
 * renda) da base. Só populado para clientes importados no formato "SaldoCartao" (único que traz
 * dataNascimento/sexo/remuneração).
 */
router.get("/perfil", async (req, res) => {
  const { tenantId } = req.user!;

  const [faixaEtariaRaw, porSexoRaw, faixaRendaRaw] = await Promise.all([
    tenantRaw.query<Array<{ faixa: string; count: bigint }>>(
      `SELECT
         CASE
           WHEN "dataNascimento" IS NULL THEN 'desconhecida'
           WHEN DATE_PART('year', AGE(NOW(), "dataNascimento")) < 26 THEN '18-25'
           WHEN DATE_PART('year', AGE(NOW(), "dataNascimento")) < 36 THEN '26-35'
           WHEN DATE_PART('year', AGE(NOW(), "dataNascimento")) < 46 THEN '36-45'
           WHEN DATE_PART('year', AGE(NOW(), "dataNascimento")) < 56 THEN '46-55'
           WHEN DATE_PART('year', AGE(NOW(), "dataNascimento")) < 66 THEN '56-65'
           ELSE '66+'
         END AS faixa,
         COUNT(*)::bigint AS count
       FROM "Client"
       WHERE "tenantId" = $1
       GROUP BY faixa`,
      tenantId
    ),
    prisma.client.groupBy({ by: ["sexo"], where: { tenantId }, _count: true }),
    tenantRaw.query<Array<{ faixa: string; count: bigint }>>(
      `SELECT
         CASE
           WHEN COALESCE("remuneracaoBruta", "remuneracaoLiquida") IS NULL THEN 'desconhecida'
           WHEN COALESCE("remuneracaoBruta", "remuneracaoLiquida") <= 1500 THEN 'Até R$ 1.500'
           WHEN COALESCE("remuneracaoBruta", "remuneracaoLiquida") <= 3000 THEN 'R$ 1.501 – 3.000'
           WHEN COALESCE("remuneracaoBruta", "remuneracaoLiquida") <= 5000 THEN 'R$ 3.001 – 5.000'
           WHEN COALESCE("remuneracaoBruta", "remuneracaoLiquida") <= 8000 THEN 'R$ 5.001 – 8.000'
           ELSE 'Acima de R$ 8.000'
         END AS faixa,
         COUNT(*)::bigint AS count
       FROM "Client"
       WHERE "tenantId" = $1
       GROUP BY faixa`,
      tenantId
    ),
  ]);

  const FAIXA_ETARIA_ORDER = ["18-25", "26-35", "36-45", "46-55", "56-65", "66+", "desconhecida"];
  const FAIXA_RENDA_ORDER = [
    "Até R$ 1.500",
    "R$ 1.501 – 3.000",
    "R$ 3.001 – 5.000",
    "R$ 5.001 – 8.000",
    "Acima de R$ 8.000",
    "desconhecida",
  ];

  const etariaMap = new Map(faixaEtariaRaw.map((f) => [f.faixa, Number(f.count)]));
  const rendaMap = new Map(faixaRendaRaw.map((f) => [f.faixa, Number(f.count)]));

  res.json({
    faixaEtaria: FAIXA_ETARIA_ORDER.filter((f) => etariaMap.has(f)).map((f) => ({ faixa: f, count: etariaMap.get(f)! })),
    porSexo: porSexoRaw.map((s) => ({ sexo: s.sexo || "Não informado", count: s._count })),
    faixaRenda: FAIXA_RENDA_ORDER.filter((f) => rendaMap.has(f)).map((f) => ({ faixa: f, count: rendaMap.get(f)! })),
  });
});

/** GET /api/dashboard/evolucao — série temporal simples de novos clientes por semana/mês */
router.get("/evolucao", async (req, res) => {
  const { tenantId } = req.user!;
  const granularity = (req.query.granularity as string) === "monthly" ? "month" : "week";

  const rows: Array<{ periodo: Date; total: bigint }> = await tenantRaw.query(
    `SELECT date_trunc('${granularity}', "createdAt") AS periodo, COUNT(*)::bigint AS total
     FROM "Client" WHERE "tenantId" = $1
     GROUP BY periodo ORDER BY periodo ASC LIMIT 52`,
    tenantId
  );

  res.json(rows.map((r) => ({ periodo: r.periodo, total: Number(r.total) })));
});

const overviewQuerySchema = z.object({
  days: z.enum(["7", "30", "90"]).default("30"),
  cidade: z.string().trim().min(1).max(120).optional(),
  empresaConveniada: z.string().trim().min(1).max(160).optional(),
});

type Insight = { tipo: "alerta" | "oportunidade" | "positivo" | "info"; texto: string };

const pct1 = (n: number) => `${n.toFixed(1).replace(".", ",")}%`;
const brl = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Variação absoluta e percentual contra a linha de base (null quando não há base real). */
function delta(current: number, base: number | null | undefined) {
  if (base === null || base === undefined) return null;
  const abs = current - base;
  return { abs, pct: base !== 0 ? (abs / base) * 100 : null };
}

/**
 * GET /api/dashboard/overview — painel premium: KPIs com variação contra o período anterior,
 * séries históricas (snapshots diários), nota de saúde, funil, oportunidades, resultado de
 * campanhas, cobertura de dados e insights. Tudo calculado de dados reais: o que ainda não tem
 * histórico/dado volta vazio ou null (a tela mostra estado vazio), nunca um valor inventado.
 *
 * Filtros (cidade, empresaConveniada) recortam os números "de agora"; o histórico (snapshots)
 * é da base inteira, então com filtro ativo as séries e variações ficam indisponíveis.
 */
router.get("/overview", async (req, res) => {
  const parsed = overviewQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Parâmetros inválidos" });
  const { tenantId } = req.user!;
  const days = Number(parsed.data.days);
  const filters: DashboardFilters = { cidade: parsed.data.cidade, empresaConveniada: parsed.data.empresaConveniada };
  const hasFilters = !!(filters.cidade || filters.empresaConveniada);

  // Primeira visita do dia grava a foto de hoje — o histórico começa a acumular sem depender de cron.
  await ensureTodaySnapshot(prisma, tenantId);

  const today = todayBrt();
  const sinceDay = addDays(today, -days);
  const sinceTs = addDays(new Date(), -days);
  const base = clientWhere(tenantId, filters);
  const raw = rawFilterSql(filters, 2);

  const notNull = (field: "cidade" | "empresaConveniada" | "remuneracaoBruta" | "dataUltimaUtilizacao" | "encerradoEm" | "dataNascimento") =>
    prisma.client.count({ where: { AND: [base, { [field]: { not: null } }] } });

  const msgBase = { campaign: { tenantId, isSandbox: false }, queuedAt: { gte: sinceTs } };

  const [
    kpis,
    snaps,
    lastImport,
    stuckImport,
    novos,
    rankingCidades,
    rankingSecretarias,
    cidadeOpts,
    convenioOpts,
    aniversariantes,
    cCidade,
    cConvenio,
    cRenda,
    cUltimaUso,
    cEncerrado,
    cNascimento,
    campanhas,
    enviadas,
    entregues,
    respondidas,
    convertidas,
    msgAgg,
  ] = await Promise.all([
    computeKpis(prisma, tenantId, filters),
    prisma.dashboardSnapshot.findMany({ where: { tenantId, day: { gte: sinceDay } }, orderBy: { day: "asc" } }),
    prisma.importJob.findFirst({ where: { tenantId }, orderBy: { startedAt: "desc" } }),
    prisma.importJob.findFirst({
      where: { tenantId, status: "EM_EXECUCAO", startedAt: { lt: addDays(new Date(), -1 / 48) } }, // > 30 min
      orderBy: { startedAt: "desc" },
    }),
    prisma.client.count({ where: { AND: [base, { createdAt: { gte: sinceTs } }] } }),
    rankingPorCampo(tenantId, "cidade"),
    rankingPorCampo(tenantId, "empresaConveniada"),
    prisma.client.groupBy({
      by: ["cidade"],
      where: { tenantId, cidade: { not: null } },
      _count: true,
      orderBy: { _count: { cidade: "desc" } },
      take: 100,
    }),
    prisma.client.groupBy({
      by: ["empresaConveniada"],
      where: { tenantId, empresaConveniada: { not: null } },
      _count: true,
      orderBy: { _count: { empresaConveniada: "desc" } },
      take: 100,
    }),
    tenantRaw.query<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM "Client"
       WHERE "tenantId" = $1 AND "dataNascimento" IS NOT NULL
         AND EXTRACT(MONTH FROM "dataNascimento") = EXTRACT(MONTH FROM (now() AT TIME ZONE 'America/Sao_Paulo')) ${raw.sql}`,
      tenantId,
      ...raw.params
    ),
    notNull("cidade"),
    notNull("empresaConveniada"),
    notNull("remuneracaoBruta"),
    notNull("dataUltimaUtilizacao"),
    notNull("encerradoEm"),
    notNull("dataNascimento"),
    prisma.campaign.count({ where: { tenantId, isSandbox: false, createdAt: { gte: sinceTs } } }),
    prisma.messageEvent.count({ where: { ...msgBase, sentAt: { not: null } } }),
    prisma.messageEvent.count({ where: { ...msgBase, deliveredAt: { not: null } } }),
    prisma.messageEvent.count({ where: { ...msgBase, respondedAt: { not: null } } }),
    prisma.messageEvent.count({ where: { ...msgBase, convertedAt: { not: null } } }),
    prisma.messageEvent.aggregate({ where: msgBase, _sum: { cost: true, convertedValue: true } }),
  ]);

  const total = kpis.totalClientes;
  const health = computeHealth({
    total,
    ativos: kpis.ativos,
    semUso: kpis.semUso,
    indefinidos: kpis.faixas["INDEFINIDO"] ?? 0,
    bloqueados: kpis.bloqueados,
    limiteTotal: kpis.limiteTotal,
    valorUtilizado: kpis.valorUtilizado,
  });

  // --- Histórico (snapshots) ---------------------------------------------------------------
  const series = snaps.map((s) => {
    const limite = Number(s.limiteTotal);
    const usado = Number(s.valorUtilizado);
    const h = computeHealth({
      total: s.totalClientes,
      ativos: s.ativos,
      semUso: s.semUso,
      indefinidos: (s.faixas as Record<string, number> | null)?.["INDEFINIDO"] ?? 0,
      bloqueados: s.bloqueados,
      limiteTotal: limite,
      valorUtilizado: usado,
    });
    return {
      day: isoDay(s.day),
      totalClientes: s.totalClientes,
      ativos: s.ativos,
      inativos: s.inativos,
      semUso: s.semUso,
      limiteTotal: limite,
      valorUtilizado: usado,
      saldoDisponivel: Number(s.saldoDisponivel),
      usoLimitePct: limite > 0 ? Number(((usado / limite) * 100).toFixed(2)) : 0,
      ativosPct: s.totalClientes > 0 ? Number(((s.ativos / s.totalClientes) * 100).toFixed(2)) : 0,
      usaramNoDia: s.usaramNoDia,
      encerradosNoDia: s.encerradosNoDia,
      score: h?.score ?? null,
    };
  });

  // Linha de base = foto mais antiga da janela, desde que seja anterior a hoje. Com histórico
  // mais curto que o período pedido, `baseline.dias` mostra o intervalo realmente comparado.
  const baselineSnap = !hasFilters && snaps.length > 0 && snaps[0].day < today ? snaps[0] : null;
  const baseline = baselineSnap
    ? {
        day: isoDay(baselineSnap.day),
        dias: Math.round((today.getTime() - baselineSnap.day.getTime()) / 86_400_000),
        pedidoDias: days,
      }
    : null;
  const bl = baselineSnap
    ? {
        totalClientes: baselineSnap.totalClientes,
        ativos: baselineSnap.ativos,
        inativos: baselineSnap.inativos,
        semUso: baselineSnap.semUso,
        limiteTotal: Number(baselineSnap.limiteTotal),
        valorUtilizado: Number(baselineSnap.valorUtilizado),
        saldoDisponivel: Number(baselineSnap.saldoDisponivel),
      }
    : null;
  const baselineHealth = baselineSnap
    ? computeHealth({
        total: baselineSnap.totalClientes,
        ativos: baselineSnap.ativos,
        semUso: baselineSnap.semUso,
        indefinidos: (baselineSnap.faixas as Record<string, number> | null)?.["INDEFINIDO"] ?? 0,
        bloqueados: baselineSnap.bloqueados,
        limiteTotal: Number(baselineSnap.limiteTotal),
        valorUtilizado: Number(baselineSnap.valorUtilizado),
      })
    : null;

  const deltas = {
    limiteTotal: delta(kpis.limiteTotal, bl?.limiteTotal),
    valorUtilizado: delta(kpis.valorUtilizado, bl?.valorUtilizado),
    saldoDisponivel: delta(kpis.saldoDisponivel, bl?.saldoDisponivel),
    ativos: delta(kpis.ativos, bl?.ativos),
    totalClientes: delta(total, bl?.totalClientes),
    inativos: delta(kpis.inativos, bl?.inativos),
    semUso: delta(kpis.semUso, bl?.semUso),
    score: health && baselineHealth ? delta(health.score, baselineHealth.score) : null,
  };

  // --- Funil e oportunidades ---------------------------------------------------------------
  const jaUtilizaram = Math.max(0, total - kpis.semUso - (kpis.faixas["INDEFINIDO"] ?? 0));
  const funil = [
    { key: "base", label: "Base total", count: total },
    { key: "utilizaram", label: "Já utilizaram o limite", count: jaUtilizaram },
    { key: "ativos", label: "Ativos hoje", count: kpis.ativos },
    { key: "quase", label: "Com 71 a 99% do limite usado", count: kpis.quaseCompleto },
  ];
  const aniversariantesCount = Number(aniversariantes[0]?.count ?? 0);
  const oportunidades = {
    inativos: kpis.inativos,
    semUso: kpis.semUso,
    quaseCompleto: kpis.quaseCompleto,
    aniversariantes: aniversariantesCount,
  };

  // --- Campanhas ---------------------------------------------------------------------------
  const rate = (n: number, d: number) => (d > 0 ? Number(((n / d) * 100).toFixed(1)) : null);
  const resultadoCampanhas = {
    temDados: enviadas > 0 || campanhas > 0,
    campanhas,
    enviadas,
    entregues,
    respondidas,
    convertidas,
    taxaEntrega: rate(entregues, enviadas),
    taxaResposta: rate(respondidas, entregues || enviadas),
    taxaConversao: rate(convertidas, enviadas),
    valorConvertido: Number(msgAgg._sum.convertedValue ?? 0),
    custo: Number(msgAgg._sum.cost ?? 0),
  };

  // --- Cobertura dos dados (o que falta preencher na origem) ----------------------------------
  const cob = (label: string, key: string, n: number, libera: string) => ({
    key,
    label,
    preenchidos: n,
    pct: total > 0 ? Number(((n / total) * 100).toFixed(1)) : 0,
    libera,
  });
  const cobertura = [
    cob("Cidade", "cidade", cCidade, "Ranking e filtro por cidade"),
    cob("Convênio / secretaria", "empresaConveniada", cConvenio, "Ranking de convênios"),
    cob("Renda", "remuneracaoBruta", cRenda, "Perfil de renda"),
    cob("Última utilização", "dataUltimaUtilizacao", cUltimaUso, "Taxa de uso por mês"),
    cob("Encerramento", "encerradoEm", cEncerrado, "Taxa de cancelamento"),
    cob("Data de nascimento", "dataNascimento", cNascimento, "Faixa etária e aniversariantes"),
  ];

  // --- Insights (todos derivados dos números acima) --------------------------------------------
  const insights: Insight[] = [];
  if (stuckImport) {
    insights.push({
      tipo: "alerta",
      texto: `Uma importação de ${stuckImport.totalRows.toLocaleString("pt-BR")} linhas (iniciada em ${stuckImport.startedAt.toLocaleDateString("pt-BR")}) nunca terminou. A base pode estar incompleta: reenvie o arquivo.`,
    });
  }
  if (total === 0) {
    insights.push({ tipo: "info", texto: "Ainda não há clientes neste recorte." });
  } else {
    if (kpis.inativos / total >= 0.5) {
      insights.push({
        tipo: "alerta",
        texto: `${pct1((kpis.inativos / total) * 100)} da base está inativa (${kpis.inativos.toLocaleString("pt-BR")} de ${total.toLocaleString("pt-BR")}). É a maior alavanca de crescimento.`,
      });
    }
    const indefinidos = kpis.faixas["INDEFINIDO"] ?? 0;
    if (indefinidos / total >= 0.3) {
      insights.push({
        tipo: "alerta",
        texto: `${indefinidos.toLocaleString("pt-BR")} clientes (${pct1((indefinidos / total) * 100)}) estão sem limite cadastrado. Os cálculos de uso ignoram esses clientes: confira a coluna de limite na planilha de origem.`,
      });
    }
    if (kpis.semUso > 0) {
      insights.push({
        tipo: "oportunidade",
        texto: `${kpis.semUso.toLocaleString("pt-BR")} clientes nunca usaram o cartão: público para campanha de ativação.`,
      });
    }
    const reativar = Math.round(kpis.inativos * 0.1);
    if (reativar >= 1) {
      insights.push({
        tipo: "oportunidade",
        texto: `Reativar 10% dos inativos significa cerca de ${reativar.toLocaleString("pt-BR")} clientes ativos a mais.`,
      });
    }
    if (kpis.limiteTotal > 0) {
      insights.push({
        tipo: "info",
        texto: `${pct1((kpis.saldoDisponivel / kpis.limiteTotal) * 100)} do limite liberado (${brl(kpis.saldoDisponivel)}) ainda está disponível para uso.`,
      });
    }
    if (kpis.quaseCompleto > 0) {
      insights.push({
        tipo: "oportunidade",
        texto: `${kpis.quaseCompleto} cliente(s) estão com 71 a 99% do limite usado: avalie renovação ou aumento.`,
      });
    }
    if (deltas.ativos && baseline && deltas.ativos.abs !== 0) {
      const sinal = deltas.ativos.abs > 0 ? "+" : "";
      insights.push({
        tipo: deltas.ativos.abs > 0 ? "positivo" : "alerta",
        texto: `Clientes ativos: ${sinal}${deltas.ativos.abs} nos últimos ${baseline.dias} dia(s).`,
      });
    }
    const semCobertura = cobertura.filter((c) => c.pct < 50);
    if (semCobertura.length > 0) {
      insights.push({
        tipo: "info",
        texto: `Dados faltando na origem: ${semCobertura.map((c) => c.label.toLowerCase()).join(", ")}. Completar a planilha libera mais análises.`,
      });
    }
  }
  if (!hasFilters && snaps.length < 2) {
    insights.push({
      tipo: "info",
      texto: `O histórico começou em ${(snaps[0]?.day ?? today).toISOString().slice(0, 10).split("-").reverse().join("/")}: tendências e variações aparecem a partir do segundo dia.`,
    });
  }

  res.json({
    periodo: { dias: days, desde: isoDay(sinceDay) },
    filtros: {
      aplicados: { cidade: filters.cidade ?? null, empresaConveniada: filters.empresaConveniada ?? null },
      cidades: cidadeOpts.map((c) => ({ valor: c.cidade as string, count: c._count })),
      convenios: convenioOpts.map((c) => ({ valor: c.empresaConveniada as string, count: c._count })),
    },
    kpis: { ...kpis, novosNoPeriodo: novos },
    deltas,
    baseline,
    historicoDisponivel: !hasFilters && snaps.length >= 2,
    series: hasFilters ? [] : series,
    saude: health ? { ...health, delta: deltas.score } : null,
    funil,
    oportunidades,
    rankingCidades: rankingCidades.map((r) => ({ cidade: r.chave, count: r.count, ativos: r.ativos, valorUtilizado: r.valorUtilizado })),
    rankingSecretarias: rankingSecretarias.map((r) => ({ empresaConveniada: r.chave, count: r.count, ativos: r.ativos, valorUtilizado: r.valorUtilizado })),
    campanhas: resultadoCampanhas,
    cobertura,
    insights,
    ultimaAtualizacao: lastImport?.finishedAt || lastImport?.startedAt || null,
  });
});

const filtersQuerySchema = z.object({
  cidade: z.string().trim().min(1).max(120).optional(),
  empresaConveniada: z.string().trim().min(1).max(160).optional(),
});

/**
 * GET /api/dashboard/perfis-renda — PF1–PF4 estimados pelo limite (ver services/rendaPerfil.ts),
 * com a quebra por faixa de uso. Clientes sem limite (comércio credenciado) ficam fora do perfil
 * e voltam à parte. Aceita os mesmos filtros de cidade/convênio do painel.
 */
router.get("/perfis-renda", async (req, res) => {
  const parsed = overviewQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Parâmetros inválidos" });
  const { tenantId } = req.user!;
  const raw = rawFilterSql({ cidade: parsed.data.cidade, empresaConveniada: parsed.data.empresaConveniada }, 5);
  const rows = await tenantRaw.query<
    Array<{ perfil: string | null; faixa: string; etapa: string; n: bigint; no_teto: bigint; sem_saldo: bigint }>
  >(
    `SELECT
       CASE
         WHEN "limiteTotal" IS NULL OR "limiteTotal" <= 0 THEN NULL
         WHEN "limiteTotal" <= $2::numeric THEN 'PF1'
         WHEN "limiteTotal" <= $3::numeric THEN 'PF2'
         WHEN "limiteTotal" <= $4::numeric THEN 'PF3'
         ELSE 'PF4'
       END AS perfil,
       "faixaUso"::text AS faixa,
       ${ETAPA_CASE_SQL} AS etapa,
       COUNT(*)::bigint AS n,
       COUNT(*) FILTER (WHERE "limiteTotal" = ${LIMITE_TETO})::bigint AS no_teto,
       COUNT(*) FILTER (WHERE "faixaUso" = 'USO_100')::bigint AS sem_saldo
     FROM "Client"
     WHERE "tenantId" = $1 ${raw.sql}
     GROUP BY 1, 2, 3`,
    tenantId,
    LIMITE_MAXIMO.PF1,
    LIMITE_MAXIMO.PF2,
    LIMITE_MAXIMO.PF3,
    ...raw.params
  );
  const perfis = PERFIS_RENDA.map((p) => {
    const mine = rows.filter((r) => r.perfil === p);
    const faixas: Record<string, number> = {};
    for (const r of mine) faixas[r.faixa] = (faixas[r.faixa] ?? 0) + Number(r.n);
    const etapas: Record<string, number> = {};
    for (const r of mine) etapas[r.etapa] = (etapas[r.etapa] ?? 0) + Number(r.n);
    const total = mine.reduce((a, r) => a + Number(r.n), 0);
    const noTeto = mine.reduce((a, r) => a + Number(r.no_teto), 0);
    return { perfil: p, label: PERFIL_LABELS[p], total, noTeto, faixas, etapas };
  });
  const semLimite = rows.filter((r) => r.perfil === null).reduce((a, r) => a + Number(r.n), 0);
  const [cob] = await tenantRaw.query<Array<{ primeira: Date | null; ultima: Date | null }>>(
    `SELECT MIN("occurredAt") AS primeira, MAX("occurredAt") AS ultima FROM "Purchase" WHERE "tenantId" = $1`,
    tenantId
  );
  res.json({ perfis, semLimite, fatorSalario: estimarSalario(1), extrato: { primeira: cob?.primeira ?? null, ultima: cob?.ultima ?? null } });
});

/**
 * GET /api/dashboard/oportunidades — fila de oportunidades (faixas de uso do limite, ativação,
 * comércio, relacionamento, qualidade dos dados e itens que dependem de histórico). Ver
 * services/opportunities.ts. Aceita os mesmos filtros de cidade/convênio do overview.
 */
router.get("/oportunidades", async (req, res) => {
  const parsed = filtersQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Parâmetros inválidos" });
  res.json(await computeOpportunities(prisma, req.user!.tenantId, parsed.data));
});

/**
 * GET /api/dashboard/audiencia — ids dos clientes de uma oportunidade (para "Criar campanha"), junto
 * da mensagem sugerida. `autorizados` conta quem de fato pode receber (sem opt-out).
 */
const audienciaSchema = filtersQuerySchema.extend({
  tipo: z.enum(OPPORTUNITY_KEYS as [OpportunityKey, ...OpportunityKey[]]),
});
router.get("/audiencia", async (req, res) => {
  const parsed = audienciaSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Parâmetros inválidos" });
  const { tenantId } = req.user!;
  const { tipo, ...filters } = parsed.data;

  const ids = await opportunityAudience(prisma, tenantId, filters, tipo);
  const autorizados = ids.length
    ? await prisma.client.count({ where: { tenantId, id: { in: ids }, autorizacaoComunicacao: true, optOutAt: null, ...ENVIAVEL_WHERE } })
    : 0;
  res.json({ tipo, total: ids.length, autorizados, clientIds: ids, mensagem: suggestedMessage(tipo) ?? null });
});

export default router;

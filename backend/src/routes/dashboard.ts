import { Router } from "express";
import { prisma } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { FAIXA_LABELS } from "../services/usage";

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
  const rows = await prisma.$queryRawUnsafe<
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
    prisma.client.count({ where: { tenantId, faixaUso: "NAO_UTILIZOU" } }),
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

  const limiteCompleto = porFaixaRaw.find((f) => f.faixaUso === "LIMITE_COMPLETO")?._count || 0;

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
    prisma.$queryRawUnsafe<Array<{ mes: Date; usados: bigint }>>(
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
    prisma.$queryRawUnsafe<Array<{ mes: Date; encerrados: bigint }>>(
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
    prisma.$queryRawUnsafe<Array<{ nivel: string; count: bigint }>>(
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
    prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM "Client"
       WHERE "tenantId" = $1 AND "dataNascimento" IS NOT NULL
         AND EXTRACT(MONTH FROM "dataNascimento") = EXTRACT(MONTH FROM CURRENT_DATE)`,
      tenantId
    ),
    prisma.$queryRawUnsafe<
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
    prisma.$queryRawUnsafe<Array<{ faixa: string; count: bigint }>>(
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
    prisma.$queryRawUnsafe<Array<{ faixa: string; count: bigint }>>(
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

  const rows: Array<{ periodo: Date; total: bigint }> = await prisma.$queryRawUnsafe(
    `SELECT date_trunc('${granularity}', "createdAt") AS periodo, COUNT(*)::bigint AS total
     FROM "Client" WHERE "tenantId" = $1
     GROUP BY periodo ORDER BY periodo ASC LIMIT 52`,
    tenantId
  );

  res.json(rows.map((r) => ({ periodo: r.periodo, total: Number(r.total) })));
});

export default router;

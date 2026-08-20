import { Router } from "express";
import { prisma } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { FAIXA_LABELS } from "../services/usage";

const router = Router();
router.use(requireAuth);

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
    cidadesRaw,
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
    prisma.client.groupBy({
      by: ["cidade"],
      where: { tenantId, cidade: { not: null } },
      _count: true,
      orderBy: { _count: { cidade: "desc" } },
      take: 10,
    }),
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
    ranking_cidades: cidadesRaw.map((c) => ({ cidade: c.cidade, count: c._count })),
    limiteTotalLiberado: agregados._sum.limiteTotal || 0,
    valorUtilizadoTotal: agregados._sum.valorUtilizado || 0,
    saldoDisponivelTotal: agregados._sum.saldoDisponivel || 0,
    ticketMedio: agregados._avg.valorUtilizado || 0,
    percentualClientes100: totalClientes ? ((limiteCompleto / totalClientes) * 100).toFixed(2) : "0.00",
    clientesSemUso: semUso,
    ultimaAtualizacao: lastImport?.finishedAt || lastImport?.startedAt || null,
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

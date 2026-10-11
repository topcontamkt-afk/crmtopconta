import { AppPrismaClient } from "../config/db";
import { runWithTenantContextAsync, withCrossTenantAccess } from "../config/tenantGuard";
import { loadRealHealth } from "./healthData";
import { refreshUsageColumns } from "./usageRefresh";
import { addDays, computeKpis, todayBrt } from "./dashboardMetrics";

/**
 * Histórico diário dos KPIs (DashboardSnapshot). Sem ele o dashboard só sabe o "agora" — com ele
 * há tendência real e variação entre períodos. Grava uma foto por tenant por dia (upsert, então
 * recalcular no mesmo dia só atualiza). O histórico começa no dia em que isto roda pela primeira
 * vez: não há como reconstruir o passado a partir do estado atual.
 *
 * Dois gatilhos, para funcionar mesmo no plano Hobby da Vercel (cron 1x/dia):
 *  - job diário (`runSnapshotJob`, /api/cron/snapshot e node-cron local);
 *  - captura "preguiçosa" na primeira visita do dia ao dashboard (`ensureTodaySnapshot`).
 */
export async function captureSnapshot(prisma: AppPrismaClient, tenantId: string, day = todayBrt()) {
  const nextDay = addDays(day, 1);
  const kpis = await computeKpis(prisma, tenantId);

  const [usaramNoDia, encerradosNoDia] = await Promise.all([
    prisma.client.count({ where: { tenantId, dataUltimaUtilizacao: { gte: day, lt: nextDay } } }),
    prisma.client.count({ where: { tenantId, encerradoEm: { gte: day, lt: nextDay } } }),
  ]);

  const real = await loadRealHealth(prisma, tenantId, {}, kpis.bloqueados, kpis.totalClientes).catch(() => null);

  const data = {
    healthScore: real?.real?.score ?? null,
    totalClientes: kpis.totalClientes,
    ativos: kpis.ativos,
    inativos: kpis.inativos,
    bloqueados: kpis.bloqueados,
    semUso: kpis.semUso,
    limiteTotal: kpis.limiteTotal,
    valorUtilizado: kpis.valorUtilizado,
    saldoDisponivel: kpis.saldoDisponivel,
    usaramNoDia,
    encerradosNoDia,
    faixas: kpis.faixas,
  };

  return prisma.dashboardSnapshot.upsert({
    where: { tenantId_day: { tenantId, day } },
    create: { tenantId, day, ...data },
    update: data,
  });
}

/** Garante que existe a foto de hoje; não falha a request que a chamou se algo der errado. */
export async function ensureTodaySnapshot(prisma: AppPrismaClient, tenantId: string): Promise<void> {
  const day = todayBrt();
  try {
    const existing = await prisma.dashboardSnapshot.findFirst({ where: { tenantId, day }, select: { id: true } });
    if (!existing) await captureSnapshot(prisma, tenantId, day);
  } catch (e) {
    console.error(`[snapshots] Falha ao capturar snapshot do tenant ${tenantId}:`, e);
  }
}

/** Job diário: tira a foto de todos os tenants. */
export async function runSnapshotJob(prisma: AppPrismaClient) {
  // Genuinely cross-tenant by design: varre todos os tenants para tirar a foto de cada um. Cada
  // tenant é re-escopado abaixo via runWithTenantContextAsync.
  const tenants = await withCrossTenantAccess(() => prisma.tenant.findMany({ select: { id: true } }));
  const results: { tenantId: string; ok: boolean; error?: string }[] = [];
  for (const t of tenants) {
    try {
      await runWithTenantContextAsync(t.id, async () => {
        await refreshUsageColumns(t.id).catch((e) => console.error(`[snapshots] uso real do tenant ${t.id}:`, e));
        await captureSnapshot(prisma, t.id);
      });
      results.push({ tenantId: t.id, ok: true });
    } catch (e: any) {
      console.error(`[snapshots] Falha no tenant ${t.id}:`, e);
      results.push({ tenantId: t.id, ok: false, error: e.message });
    }
  }
  return { tenants: tenants.length, results };
}

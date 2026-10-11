import { AppPrismaClient, tenantRaw } from "../config/db";
import { avaliarFrescor } from "./dataFreshness";
import { DashboardFilters, rawFilterSql } from "./dashboardMetrics";
import { ETAPA_CASE_SQL } from "./etapaUso";
import { computeRealHealth, RealHealthResult } from "./health";

/**
 * Carrega as contagens por etapa de uso (só clientes com limite) e a data do último extrato, e
 * calcula a nota por uso real. Devolve `null` quando a nota real não é confiável — sem extrato ou
 * extrato parado (dataFreshness.ts): nesse caso o dashboard cai na nota estimada e avisa.
 */
export interface RealHealthLoad {
  real: RealHealthResult | null;
  motivo: "OK" | "SEM_EXTRATO" | "EXTRATO_DESATUALIZADO" | "SEM_CLIENTES";
  ultimaTransacao: Date | null;
}

export async function loadRealHealth(
  prisma: AppPrismaClient,
  tenantId: string,
  filters: DashboardFilters,
  bloqueados: number,
  total: number
): Promise<RealHealthLoad> {
  const agg = await prisma.purchase.aggregate({ where: { tenantId }, _max: { occurredAt: true } });
  const ultimaTransacao = agg._max.occurredAt ?? null;
  const frescor = avaliarFrescor(ultimaTransacao);
  if (frescor.status === "SEM_DADOS") return { real: null, motivo: "SEM_EXTRATO", ultimaTransacao };
  if (frescor.status === "DESATUALIZADO") return { real: null, motivo: "EXTRATO_DESATUALIZADO", ultimaTransacao };

  const raw = rawFilterSql(filters, 2);
  const rows = await tenantRaw.query<Array<{ etapa: string; n: bigint }>>(
    `SELECT ${ETAPA_CASE_SQL} AS etapa, COUNT(*)::bigint AS n FROM "Client"
     WHERE "tenantId" = $1 AND "limiteTotal" > 0 ${raw.sql} GROUP BY 1`,
    tenantId,
    ...raw.params
  );
  const n = (e: string) => Number(rows.find((r) => r.etapa === e)?.n ?? 0);
  const comLimite = rows.reduce((a, r) => a + Number(r.n), 0);
  const real = computeRealHealth({
    comLimite,
    nuncaUsou: n("NUNCA_USOU"),
    recorrente: n("RECORRENTE"),
    ocasional: n("OCASIONAL"),
    emRisco: n("EM_RISCO"),
    inativo: n("INATIVO"),
    bloqueados,
    total,
  });
  return { real, motivo: real ? "OK" : "SEM_CLIENTES", ultimaTransacao };
}

import { AppPrismaClient, tenantRaw } from "../config/db";
import { runWithTenantContextAsync, withCrossTenantAccess } from "../config/tenantGuard";
import { JANELA_USOS_DIAS } from "./etapaUso";
import { agoraSql, usoRealSql } from "../config/sql";

/**
 * Recalcula as colunas de uso real do cliente (ultimoUsoReal, usosUltimos90d, usosTotal) a partir
 * do extrato (Purchase). Conta só o que o transactionClassifier considera uso: "Débito Pix..."
 * (antecipação) e "Compra à Vista..." — assinatura, fatura e tipos desconhecidos ficam de fora.
 * A classificação fica gravada em Purchase.usoTipo (classifyTransaction, ver config/derivedColumns.ts).
 * Idempotente; roda após cada importação de compras e no job diário.
 */
export const USO_TIPO_SQL = usoRealSql();

export async function refreshUsageColumns(tenantId: string): Promise<number> {
  // Zera quem não tem mais nenhum uso no extrato (ex.: compras removidas) e recalcula os demais.
  await tenantRaw.execute(
    `UPDATE "Client" SET "ultimoUsoReal" = NULL, "usosUltimos90d" = 0, "usosTotal" = 0
     WHERE "tenantId" = $1 AND ("usosTotal" > 0 OR "ultimoUsoReal" IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM "Purchase" p WHERE p."clientId" = "Client".id AND p."tenantId" = $1 AND ${usoRealSql("p")})`,
    tenantId
  );
  return tenantRaw.execute(
    `UPDATE "Client" SET "ultimoUsoReal" = s.ult, "usosUltimos90d" = s.n90, "usosTotal" = s.tot
     FROM (
       SELECT "clientId", MAX("occurredAt") AS ult,
              COUNT(*) FILTER (WHERE "occurredAt" >= ${agoraSql(JANELA_USOS_DIAS)}) AS n90,
              COUNT(*) AS tot
       FROM "Purchase"
       WHERE "tenantId" = $1 AND ${USO_TIPO_SQL}
       GROUP BY "clientId"
     ) AS s
     WHERE "Client".id = s."clientId" AND "Client"."tenantId" = $1`,
    tenantId
  );
}

/** Job diário: refaz as colunas de todos os tenants (a janela de 90 dias anda com o calendário). */
export async function runUsageRefreshJob(prisma: AppPrismaClient) {
  const tenants = await withCrossTenantAccess(() => prisma.tenant.findMany({ select: { id: true } }));
  const results: { tenantId: string; ok: boolean; atualizados?: number; error?: string }[] = [];
  for (const t of tenants) {
    try {
      const atualizados = await runWithTenantContextAsync(t.id, () => refreshUsageColumns(t.id));
      results.push({ tenantId: t.id, ok: true, atualizados });
    } catch (e: any) {
      console.error(`[usageRefresh] Falha no tenant ${t.id}:`, e);
      results.push({ tenantId: t.id, ok: false, error: e.message });
    }
  }
  return { tenants: tenants.length, results };
}

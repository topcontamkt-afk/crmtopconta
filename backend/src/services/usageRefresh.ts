import { AppPrismaClient, tenantRaw } from "../config/db";
import { runWithTenantContextAsync, withCrossTenantAccess } from "../config/tenantGuard";
import { JANELA_USOS_DIAS } from "./etapaUso";

/**
 * Recalcula as colunas de uso real do cliente (ultimoUsoReal, usosUltimos90d, usosTotal) a partir
 * do extrato (Purchase). Conta só o que o transactionClassifier considera uso: "Débito Pix..."
 * (antecipação) e "Compra à Vista..." — assinatura, fatura e tipos desconhecidos ficam de fora.
 * Os padrões abaixo espelham classifyTransaction (casamento sem depender de acento/caixa).
 * Idempotente; roda após cada importação de compras e no job diário.
 */
export const USO_TIPO_SQL = `("tipo" ~* '^\\s*d[eé]bito\\s+pix' OR "tipo" ~* '^\\s*compra\\s+[àa]\\s+vista')`;

export async function refreshUsageColumns(tenantId: string): Promise<number> {
  // Zera quem não tem mais nenhum uso no extrato (ex.: compras removidas) e recalcula os demais.
  await tenantRaw.execute(
    `UPDATE "Client" c SET "ultimoUsoReal" = NULL, "usosUltimos90d" = 0, "usosTotal" = 0
     WHERE c."tenantId" = $1 AND (c."usosTotal" > 0 OR c."ultimoUsoReal" IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM "Purchase" p WHERE p."clientId" = c.id AND p."tenantId" = $1 AND ${USO_TIPO_SQL.replace(/"tipo"/g, 'p."tipo"')})`,
    tenantId
  );
  return tenantRaw.execute(
    `UPDATE "Client" c SET "ultimoUsoReal" = s.ult, "usosUltimos90d" = s.n90, "usosTotal" = s.tot
     FROM (
       SELECT "clientId", MAX("occurredAt") AS ult,
              COUNT(*) FILTER (WHERE "occurredAt" >= now() - interval '${JANELA_USOS_DIAS} days')::int AS n90,
              COUNT(*)::int AS tot
       FROM "Purchase"
       WHERE "tenantId" = $1 AND ${USO_TIPO_SQL}
       GROUP BY "clientId"
     ) s
     WHERE c.id = s."clientId" AND c."tenantId" = $1`,
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

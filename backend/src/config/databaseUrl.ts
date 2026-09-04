/**
 * DATABASE_URL/DATABASE_URL_ADMIN apontam para o connection pooler do Supabase (PgBouncer,
 * porta 6543, modo "transaction" — ver schema.prisma). Nesse modo o pooler não garante a mesma
 * conexão física entre o PREPARE e o EXECUTE de um prepared statement quando há concorrência, o
 * que produz erros intermitentes do tipo `prepared statement "sN" does not exist`.
 * `pgbouncer=true` faz o Prisma usar o protocolo simples (sem prepared statements) — é a
 * correção documentada para Prisma + PgBouncer em modo transaction.
 * `connection_limit=5`: pool pequeno por invocação, para permitir algum paralelismo real dentro
 * de uma mesma função serverless sem abrir conexões demais no pooler compartilhado.
 *
 * Extraído de config/db.ts para ser reaproveitado por config/tenantGuard.ts (client admin usado
 * pelo desvio cross-tenant, ver withCrossTenantAccess) sem criar import circular entre os dois.
 */
export function poolerSafeDatabaseUrl(raw: string | undefined): string | undefined {
  if (!raw || raw.includes("pgbouncer=")) return raw;
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}pgbouncer=true&connection_limit=5`;
}

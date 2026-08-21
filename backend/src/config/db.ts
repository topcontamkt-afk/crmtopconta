import { PrismaClient } from "@prisma/client";

// DATABASE_URL aponta para o connection pooler do Supabase (PgBouncer, porta 6543, modo
// "transaction" — ver schema.prisma). Nesse modo o pooler não garante a mesma conexão física
// entre o PREPARE e o EXECUTE de um prepared statement quando há concorrência (várias
// invocações serverless ao mesmo tempo), o que produz erros intermitentes do tipo
// `prepared statement "sN" does not exist` ou `bind message supplies N parameters, but
// prepared statement requires M`. `pgbouncer=true` faz o Prisma usar o protocolo simples
// (sem prepared statements) nessa conexão — é a correção documentada para Prisma + PgBouncer
// em modo transaction, e é ela que resolve o bug de fato (não o connection_limit abaixo).
// `connection_limit=5`: um pequeno pool por invocação, para permitir algum paralelismo real
// dentro de uma mesma função serverless (ex.: importação em lote gravando várias linhas ao
// mesmo tempo) sem abrir conexões demais no pooler compartilhado.
function poolerSafeDatabaseUrl(): string | undefined {
  const raw = process.env.DATABASE_URL;
  if (!raw || raw.includes("pgbouncer=")) return raw;
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}pgbouncer=true&connection_limit=5`;
}

export const prisma = new PrismaClient({
  datasources: { db: { url: poolerSafeDatabaseUrl() } },
});

import { PrismaClient } from "@prisma/client";
import { tenantGuardExtension } from "./tenantGuard";

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

// tenantGuardExtension: compensating control for tenant isolation, since RLS is enabled with
// zero policies on every table and the app's DB role bypasses RLS anyway (see
// src/config/tenantGuard.ts for the full writeup). Applied here so every caller of this shared
// client — routes and services alike — gets the guard automatically; there is no other place in
// the codebase that constructs a PrismaClient.
export const prisma = new PrismaClient({
  datasources: { db: { url: poolerSafeDatabaseUrl() } },
}).$extends(tenantGuardExtension);

// Prisma's `$extends()` return type intentionally drops `$on`/`$use` (extensions replace the
// old middleware API), so it isn't assignable to the plain `PrismaClient` type. Every service
// function that receives the shared client as a parameter should be typed with this alias
// instead of importing `PrismaClient` from "@prisma/client" directly.
export type AppPrismaClient = typeof prisma;

import { PrismaClient } from "@prisma/client";
import { poolerSafeDatabaseUrl } from "./databaseUrl";
import { tenantGuardExtension } from "./tenantGuard";

// DATABASE_URL conecta como o role `app_runtime` (RLS real, sem BYPASSRLS — ver migration
// add_rls_policies e services/auditIntegrity.ts/config/tenantGuard.ts para o resto do desenho).
// tenantGuardExtension: (1) defesa em profundidade em código, lançando erro se uma query num
// modelo tenant-scoped não filtrar por tenantId; (2) abre cada operação numa transaction que
// primeiro seta a GUC `app.tenant_id` (via set_config, `SET LOCAL` não aceita bind parameter)
// que as policies do Postgres usam — sem isso, toda query contra app_runtime veria zero linhas
// (RLS falha fechado). Aplicado aqui para que todo chamador deste client compartilhado — rotas
// e services — ganhe ambas as camadas automaticamente; não há outro lugar no backend que
// construa um PrismaClient para tráfego de request (prisma/seed.ts é a única exceção
// deliberada, por precisar do role administrativo para criar o próprio Tenant).
export const prisma = new PrismaClient({
  datasources: { db: { url: poolerSafeDatabaseUrl(process.env.DATABASE_URL) } },
}).$extends(tenantGuardExtension);

// Prisma's `$extends()` return type intentionally drops `$on`/`$use` (extensions replace the
// old middleware API), so it isn't assignable to the plain `PrismaClient` type. Every service
// function that receives the shared client as a parameter should be typed with this alias
// instead of importing `PrismaClient` from "@prisma/client" directly.
export type AppPrismaClient = typeof prisma;

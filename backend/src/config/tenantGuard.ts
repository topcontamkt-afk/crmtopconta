import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma, PrismaClient } from "@prisma/client";
import { poolerSafeDatabaseUrl } from "./databaseUrl";

/**
 * Tenant isolation: two layers, both enforced from this one Prisma Client extension.
 *
 * Layer 1 (RLS real): `DATABASE_URL` conecta como `app_runtime`, um role Postgres SEM
 * `BYPASSRLS`, e todas as 14 tabelas têm policies (`current_setting('app.tenant_id')`, ver
 * migration `add_rls_policies`) — o próprio Postgres recusa/filtra qualquer linha fora do
 * tenant da sessão, mesmo que o código esqueça um filtro. A GUC de sessão precisa ser setada a
 * cada operação (não por conexão inteira, porque o pooler do Supabase está em modo "transaction"
 * — uma mesma conexão física é reciclada entre requests diferentes) — é o que a parte "abre uma
 * transaction e roda set_config(...)" deste arquivo faz.
 *
 * Layer 2 (defesa em profundidade em código, histórica): antes da RLS real existir, esta era a
 * ÚNICA linha de defesa (RLS estava ligado mas com zero policies, e o role de conexão tinha
 * `rolbypassrls = true` — decorativo). Mantida mesmo com a RLS real em vigor: lança erro — não
 * warning — se uma query "de conjunto" (findMany/updateMany/etc.) num modelo tenant-scoped não
 * filtrar por `tenantId`, pegando o bug em dev/CI antes mesmo de chegar ao banco (mais rápido e
 * mais claro que descobrir via "por que essa lista veio vazia" depois que a RLS já filtrou).
 */

/**
 * Every Prisma model that carries its own `tenantId` scalar field, per prisma/schema.prisma.
 * Confirmed by grepping the schema for `tenantId` — NOT every model with tenant-owned data:
 * `Movement` (scoped via `Client.tenantId`) and `MessageEvent` (scoped via `Campaign.tenantId`)
 * are deliberately excluded because they have no `tenantId` column of their own to check; their
 * tenant scoping happens through their parent relation instead (e.g.
 * `movement.findMany({ where: { client: { tenantId } } } )`), which this guard cannot see.
 * `Tenant` itself is excluded — it IS the tenant, not tenant-scoped data.
 */
export const TENANT_SCOPED_MODELS = [
  "User",
  "Client",
  "ImportJob",
  "SegmentDefinition",
  "Campaign",
  "AutomationRule",
  "AuditLog",
  "SheetConnection",
  "ChannelConfig",
  "MessageTemplate",
  "Notification",
] as const;

type TenantScopedModel = (typeof TENANT_SCOPED_MODELS)[number];

function isTenantScopedModel(model: string | undefined): model is TenantScopedModel {
  return !!model && (TENANT_SCOPED_MODELS as readonly string[]).includes(model);
}

/**
 * Operations guarded (must have `tenantId` in `where`): findMany, findFirst, findFirstOrThrow,
 * count, aggregate, groupBy, updateMany, deleteMany.
 *
 * These are exactly the "set" operations — no unique identifier is required in their `where`,
 * so a missing/wrong filter silently returns or mutates rows across every tenant in the
 * database. That is the failure mode this guard exists to catch.
 *
 * Deliberately NOT guarded: findUnique/findUniqueOrThrow/update/delete/upsert. Prisma requires
 * these to be keyed by a globally-unique identifier (the `id` primary key, or a compound unique
 * constraint) — by construction they can touch at most one row, so a missing tenantId there
 * cannot cause the "silent whole-table leak" this guard targets; the residual risk is a
 * single-record IDOR (an attacker guessing/enumerating another tenant's id), which is a
 * different vulnerability class requiring a different fix (verify-then-act at the route level).
 * This codebase already follows a consistent verify-then-act convention for exactly that reason:
 * every by-id mutation route first does a tenant-scoped `findFirst({ where: { id, tenantId } })`
 * (which IS guarded) and only then calls `.update({ where: { id } })` / `.delete({ where: { id } })`
 * on the id it just verified — see e.g. routes/segments.ts, routes/templates.ts,
 * routes/notifications.ts, routes/integrations.ts. Hard-enforcing tenantId on the singular
 * update/delete call itself would require reshaping every one of those call sites (Prisma *does*
 * support extra non-unique filters alongside the unique key since the "extended where unique
 * input" feature, e.g. `update({ where: { id, tenantId } })`, so it's not impossible — just out
 * of scope for this pass). Flagging an audit of by-id GET/PATCH/DELETE routes for IDOR as a
 * follow-up is worth tracking alongside the real-RLS roadmap item.
 */
const GUARDED_OPERATIONS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "updateMany",
  "deleteMany",
]);

/** create/createMany take tenantId in `data`, not `where` — checked separately below. */
const CREATE_OPERATIONS = new Set(["create", "createMany"]);

/**
 * Recursively checks whether a Prisma `where` object includes `tenantId` as a filter, including
 * when it's nested inside `AND` / `OR` / `NOT` combinators (which can themselves be a single
 * object or an array of objects, and can nest arbitrarily deep — see services/segments.ts
 * `buildGroupWhere`, which builds exactly this shape for dynamic segment queries).
 *
 * Note this only checks for the *key* `tenantId` being present — it doesn't (and can't cheaply)
 * verify the value is non-empty/correct. That's consistent with the rest of the app: the value
 * always comes from `req.user.tenantId` (a verified JWT claim) or a loop variable, never from
 * unauthenticated input.
 */
export function whereHasTenantId(where: unknown): boolean {
  if (!where || typeof where !== "object") return false;
  const w = where as Record<string, unknown>;

  if ("tenantId" in w) return true;

  for (const combinator of ["AND", "OR", "NOT"] as const) {
    const value = w[combinator];
    if (value === undefined) continue;
    const items = Array.isArray(value) ? value : [value];
    if (items.some((item) => whereHasTenantId(item))) return true;
  }

  return false;
}

/**
 * Escape hatch for genuinely tenant-agnostic queries: background/cron jobs that must scan
 * across ALL tenants by design (e.g. "for every active SheetConnection, regardless of tenant,
 * check whether it's due to sync now"). There is no admin/cross-tenant role or endpoint in this
 * app (every HTTP route is scoped by `req.user.tenantId` from the JWT, see middleware/auth.ts)
 * — the only legitimate callers of this are the scheduler jobs in services/scheduler.ts and
 * services/automationEngine.ts.
 *
 * Wrap ONLY the specific prisma call(s) that need this, as narrowly as possible, and always with
 * a comment at the call site explaining why the query is legitimately cross-tenant. Every use of
 * this function is a manually-reviewed exception to the guard — grep for it to find all of them.
 * Legitimate callers today: the scheduler jobs in services/scheduler.ts and
 * services/automationEngine.ts, plus the AuditLog hash-chain reads in
 * services/auditIntegrity.ts (the tamper-evidence chain is global across tenants by design).
 */
const bypassContext = new AsyncLocalStorage<boolean>();

export function withCrossTenantAccess<T>(fn: () => Promise<T>): Promise<T> {
  // Must `await` fn() *inside* the run() callback, not just return the un-awaited promise: Prisma's
  // findMany()/etc. return a lazy thenable whose `.then()` (where the $allOperations hook actually
  // fires — see tenantGuard.test.ts and the stack traces that motivated this comment) may not be
  // called until the caller awaits the value returned by withCrossTenantAccess(). By then, run()
  // has already returned synchronously and the ALS context is gone. Awaiting here ensures the
  // `.then()` call happens while the "true" store is still the active context.
  return bypassContext.run(true, async () => await fn());
}

/**
 * Client administrativo (role privilegiado de sempre, `DATABASE_URL_ADMIN` — o mesmo valor que
 * `DATABASE_URL` tinha antes da migração para RLS real, `rolbypassrls = true`), usado
 * EXCLUSIVAMENTE pelo desvio de `withCrossTenantAccess()` abaixo. Sem extensão nenhuma — os
 * scheduler jobs que usam esse caminho fazem queries genuinamente sem tenantId de propósito, e
 * não têm um `app.tenant_id` de sessão pra setar (não há "o" tenant de um job cross-tenant).
 * Construído de forma independente de config/db.ts (em vez de importado de lá) para não criar
 * import circular — db.ts já importa `tenantGuardExtension` deste módulo.
 */
const prismaAdmin = new PrismaClient({
  datasources: { db: { url: poolerSafeDatabaseUrl(process.env.DATABASE_URL_ADMIN) } },
});

/** "AutomationRule" -> "automationRule" — nome do model Prisma para a chave do client delegate. */
function modelToDelegateKey(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

/**
 * tenantId da request atual (setado por middleware/auth.ts logo após verificar o JWT — ver
 * requireAuth). É o valor usado para popular a GUC `app.tenant_id` que as policies de RLS leem.
 * Nunca setado durante um job de scheduler (esses usam bypassContext/prismaAdmin acima, não
 * este contexto) nem em scripts fora do processo HTTP (ex.: prisma/seed.ts usa seu próprio
 * PrismaClient contra DATABASE_URL_ADMIN diretamente, por precisar criar o próprio Tenant antes
 * de qualquer tenantId existir para setar).
 */
const requestTenantContext = new AsyncLocalStorage<string>();

/**
 * Versão síncrona — usada só por middleware/auth.ts para envolver `next()` (a chamada em si é
 * void/síncrona; o resto da cadeia de middlewares/rota herda o contexto normalmente via
 * continuação assíncrona nativa, sem risco de perda de contexto).
 */
export function runWithTenantContext<T>(tenantId: string, fn: () => T): T {
  return requestTenantContext.run(tenantId, fn);
}

/**
 * Versão para trabalho assíncrono (jobs de scheduler processando um tenant por vez após uma
 * varredura cross-tenant — ver services/scheduler.ts/automationEngine.ts/retention.ts/
 * biExport.ts). `await fn()` *dentro* do callback de `run()`, não um tail-call sem await, pelo
 * mesmo motivo documentado em withCrossTenantAccess acima: a lazy thenable do Prisma só chama
 * `.then()` quando algo efetivamente aguarda a promise, e isso precisa acontecer sincronamente
 * dentro do `.run()` para não perder o contexto do AsyncLocalStorage. Centralizado aqui (em vez
 * de exigir que cada call site lembre de fazer isso certo) para não repetir o mesmo bug já
 * corrigido uma vez neste arquivo.
 */
export function runWithTenantContextAsync<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return requestTenantContext.run(tenantId, async () => await fn());
}

/**
 * Evita recursão infinita: depois de abrir a transaction e rodar `set_config(...)`, a operação
 * real é despachada de novo através de `tx[model][operation]()` — que passa por este MESMO hook
 * de extensão outra vez (extensions se aplicam a `tx` também). Esse flag marca "já estamos
 * dentro do nosso próprio wrapper, só execute a query" na segunda passada.
 */
const withinRlsWrapper = new AsyncLocalStorage<boolean>();

/** Prisma Client extension implementing the guard described above. */
export const tenantGuardExtension = Prisma.defineExtension((client) =>
  client.$extends({
    name: "tenantGuard",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (bypassContext.getStore()) {
            // Cross-tenant de propósito (scheduler jobs): despacha no client administrativo, a
            // única conexão que não tem RLS pra satisfazer — rodar isso em `query(args)` (a
            // conexão restrita de app_runtime) veria zero linhas sob RLS sem GUC setada.
            return (prismaAdmin as unknown as Record<string, Record<string, (a: unknown) => unknown>>)[
              modelToDelegateKey(model)
            ][operation](args);
          }

          if (withinRlsWrapper.getStore()) {
            return query(args);
          }

          if (isTenantScopedModel(model)) {
            if (GUARDED_OPERATIONS.has(operation)) {
              const where = (args as { where?: unknown } | undefined)?.where;
              if (!whereHasTenantId(where)) {
                throw new Error(
                  `[tenantGuard] Refusing to run ${model}.${operation}() without "tenantId" in ` +
                    `the where clause. Every query against a tenant-scoped model must filter by ` +
                    `tenantId to avoid a cross-tenant data leak. If this query is genuinely ` +
                    `tenant-agnostic (e.g. a scheduler job scanning all tenants), wrap it in ` +
                    `withCrossTenantAccess() from src/config/tenantGuard.ts and document why.`
                );
              }
            } else if (CREATE_OPERATIONS.has(operation)) {
              // Defense in depth: tenantId is a required, non-nullable, no-default scalar on
              // every one of these models, so TypeScript/Prisma already reject a well-typed
              // create() missing it at compile time. This extra runtime check only catches
              // callers that bypass the types (e.g. `data: someUntypedObject as any`).
              const data = (args as { data?: unknown } | undefined)?.data;
              const items = Array.isArray(data) ? data : [data];
              const missing = items.some(
                (item) => !item || typeof item !== "object" || !("tenantId" in item)
              );
              if (missing) {
                throw new Error(
                  `[tenantGuard] Refusing to run ${model}.${operation}() with "data" missing ` +
                    `"tenantId". Every row created on a tenant-scoped model must carry its tenantId.`
                );
              }
            }
          }

          const tenantId = requestTenantContext.getStore();
          if (!tenantId) {
            throw new Error(
              `[tenantGuard] Refusing to run ${model}.${operation}() with no tenant context set. ` +
                `Every query outside a scheduler job (withCrossTenantAccess) must run inside an ` +
                `authenticated request (requireAuth sets this via runWithTenantContext) — RLS ` +
                `would silently return zero rows without it.`
            );
          }

          // RLS real: abre uma transaction (o pooler do Supabase está em modo "transaction" —
          // uma GUC setada fora de uma transaction não sobreviveria de forma confiável até a
          // query real rodar, podendo vazar para o próximo request que reusar a mesma conexão
          // física). set_config(..., true) = equivalente a SET LOCAL, mas aceita bind parameter
          // (SET LOCAL em si não aceita — por isso não é `SET LOCAL app.tenant_id = ${tenantId}`).
          return client.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
            // async+await (not a bare arrow returning the promise) is required here for the same
            // reason documented on withCrossTenantAccess above: Prisma's query objects are lazy
            // thenables whose .then() may not fire until awaited, and by then run()'s ALS context
            // could already be gone.
            return withinRlsWrapper.run(
              true,
              async () =>
                await (tx as unknown as Record<string, Record<string, (a: unknown) => unknown>>)[
                  modelToDelegateKey(model)
                ][operation](args)
            );
          });
        },
      },
    },
  })
);

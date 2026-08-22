import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma } from "@prisma/client";

/**
 * Compensating control for tenant isolation.
 *
 * Context: Row Level Security is enabled on every table in the Supabase Postgres database, but
 * has ZERO policies, and the role our DATABASE_URL connects as (`postgres`) has
 * `rolbypassrls = true`. RLS is therefore pure decoration today — tenant isolation is enforced
 * ONLY by every Prisma query in this app manually including `where: { tenantId: ... }`. A single
 * route that forgets that filter on a list/aggregate/bulk-mutate query is a silent cross-tenant
 * PII leak. (Real RLS with a non-bypass role and session-scoped policies is tracked separately
 * as a roadmap item — out of scope here.)
 *
 * This Prisma Client extension is a fast, in-app safety net: it throws a hard error — not a
 * warning — whenever a guarded operation on a tenant-scoped model is called with a `where`
 * clause that doesn't include `tenantId` (at the top level, or nested inside `AND`/`OR`/`NOT`).
 * The goal is to turn a missing-tenantId bug into an immediate 500 in dev/CI/staging instead of
 * a silent leak in production.
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

/** Prisma Client extension implementing the guard described above. */
export const tenantGuardExtension = Prisma.defineExtension((client) =>
  client.$extends({
    name: "tenantGuard",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (bypassContext.getStore()) {
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

          return query(args);
        },
      },
    },
  })
);

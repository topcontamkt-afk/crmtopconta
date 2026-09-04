/**
 * Fake do PrismaClient administrativo (usado só pelo desvio de withCrossTenantAccess — ver
 * tenantGuard.ts). Precisa ser mockado ANTES do import de "./tenantGuard" porque esse módulo
 * constrói `prismaAdmin = new PrismaClient(...)` no escopo do módulo. Nome prefixado com "mock"
 * por exigência do jest (module factories não podem referenciar variáveis fora de escopo a
 * menos que comecem com "mock").
 */
const mockAdminCalls: Array<{ model: string; operation: string; args: unknown }> = [];
const mockAdminDelegate = new Proxy(
  {},
  {
    get: (_target, model: string) =>
      new Proxy(
        {},
        {
          get:
            (_t2, operation: string) =>
            (args: unknown) => {
              mockAdminCalls.push({ model, operation, args });
              return Promise.resolve(["admin-result"]);
            },
        }
      ),
  }
);

jest.mock("@prisma/client", () => {
  const actual = jest.requireActual("@prisma/client");
  return { ...actual, PrismaClient: jest.fn().mockImplementation(() => mockAdminDelegate) };
});

import {
  TENANT_SCOPED_MODELS,
  runWithTenantContext,
  tenantGuardExtension,
  whereHasTenantId,
  withCrossTenantAccess,
} from "./tenantGuard";

/**
 * These tests exercise the guard's decision logic without touching a real database — see the
 * live smoke test performed manually against local Postgres (docker compose) in this session,
 * which is what actually proves the transaction/recursion mechanics work end-to-end (login +
 * tenant update + tamper-detection all correctly RLS-scoped). These tests cover the DECISION
 * logic in isolation: what gets rejected, what gets dispatched, and to which connection.
 *
 * `makeFakeClient()` extracts the extension's `$allOperations` hook the same way Prisma's
 * extension runtime invokes it, and provides a fake `$transaction(callback)` whose `tx` records
 * every `[model][operation](args)` call instead of really opening a DB transaction — good enough
 * to prove tenantGuard opens ONE transaction, sets the right GUC value, and dispatches the right
 * op/args, without needing to fully re-simulate Prisma's extension-composes-with-tx behavior.
 */
function makeFakeClient() {
  let captured: any;
  const txCalls: Array<{ model: string; operation: string; args: unknown }> = [];
  const executeRawCalls: unknown[][] = [];

  const fakeClient = {
    $extends(config: any) {
      captured = config.query.$allModels.$allOperations;
      return config;
    },
    async $transaction(callback: (tx: any) => Promise<any>) {
      const txBase = {
        $executeRaw: (_strings: TemplateStringsArray, ...values: unknown[]) => {
          executeRawCalls.push(values);
          return Promise.resolve(undefined);
        },
      };
      const tx = new Proxy(txBase, {
        get(target, prop: string) {
          if (prop in target) return (target as any)[prop];
          return new Proxy(
            {},
            {
              get:
                (_t2, operation: string) =>
                (args: unknown) => {
                  txCalls.push({ model: prop, operation, args });
                  return Promise.resolve({ ok: true });
                },
            }
          );
        },
      });
      return callback(tx);
    },
  };

  (tenantGuardExtension as unknown as (client: any) => any)(fakeClient);
  if (typeof captured !== "function") {
    throw new Error("could not extract $allOperations hook from tenantGuardExtension");
  }

  return {
    hook: captured as (params: {
      model?: string;
      operation: string;
      args: any;
      query: (args: any) => Promise<any>;
    }) => Promise<any>,
    txCalls,
    executeRawCalls,
  };
}

describe("whereHasTenantId", () => {
  it("finds a flat top-level tenantId", () => {
    expect(whereHasTenantId({ tenantId: "t1", cidade: "São Paulo" })).toBe(true);
  });

  it("returns false when tenantId is absent", () => {
    expect(whereHasTenantId({ cidade: "São Paulo" })).toBe(false);
    expect(whereHasTenantId(undefined)).toBe(false);
    expect(whereHasTenantId(null)).toBe(false);
    expect(whereHasTenantId({})).toBe(false);
  });

  it("finds tenantId nested inside OR (array form), matching buildGroupWhere's output", () => {
    const where = {
      OR: [
        { tenantId: "t1", cidade: "São Paulo" },
        { tenantId: "t1", cidade: "Rio de Janeiro" },
      ],
    };
    expect(whereHasTenantId(where)).toBe(true);
  });

  it("finds tenantId nested inside AND (array form)", () => {
    const where = { AND: [{ tenantId: "t1" }, { faixaUso: "USO_ALTO" }] };
    expect(whereHasTenantId(where)).toBe(true);
  });

  it("finds tenantId nested inside NOT (single-object form)", () => {
    const where = { NOT: { tenantId: "t1" } };
    expect(whereHasTenantId(where)).toBe(true);
  });

  it("does not find tenantId when every branch of OR lacks it", () => {
    const where = { OR: [{ cidade: "São Paulo" }, { cidade: "Rio de Janeiro" }] };
    expect(whereHasTenantId(where)).toBe(false);
  });

  it("recurses into deeply nested AND/OR combinations", () => {
    const where = { AND: [{ OR: [{ AND: [{ tenantId: "t1" }] }] }] };
    expect(whereHasTenantId(where)).toBe(true);
  });
});

describe("TENANT_SCOPED_MODELS", () => {
  it("lists exactly the models that carry their own tenantId column in prisma/schema.prisma", () => {
    expect([...TENANT_SCOPED_MODELS].sort()).toEqual(
      [
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
      ].sort()
    );
  });
});

describe("tenantGuard $allOperations hook — code-level checks (run before any DB access)", () => {
  it("throws on a guarded operation against a tenant-scoped model with no tenantId in where", async () => {
    const { hook, txCalls } = makeFakeClient();

    await expect(
      hook({ model: "Client", operation: "findMany", args: { where: { cidade: "São Paulo" } }, query: jest.fn() })
    ).rejects.toThrow(/tenantGuard/);

    // The whole point: no transaction/DB access happens on the reject path.
    expect(txCalls).toHaveLength(0);
  });

  it("throws for every guarded operation, not just findMany", async () => {
    const { hook, txCalls } = makeFakeClient();
    const guardedOps = ["findFirst", "findFirstOrThrow", "count", "aggregate", "groupBy", "updateMany", "deleteMany"];

    for (const operation of guardedOps) {
      await expect(
        hook({ model: "SegmentDefinition", operation, args: { where: { name: "x" } }, query: jest.fn() })
      ).rejects.toThrow(/tenantGuard/);
    }
    expect(txCalls).toHaveLength(0);
  });

  it("throws on create/createMany for a tenant-scoped model when data is missing tenantId", async () => {
    const { hook, txCalls } = makeFakeClient();

    await expect(
      hook({ model: "Notification", operation: "create", args: { data: { message: "oi" } }, query: jest.fn() })
    ).rejects.toThrow(/tenantGuard/);

    await expect(
      hook({
        model: "Notification",
        operation: "createMany",
        args: { data: [{ message: "oi" }, { tenantId: "t1", message: "ok" }] },
        query: jest.fn(),
      })
    ).rejects.toThrow(/tenantGuard/);
    expect(txCalls).toHaveLength(0);
  });

  it("throws when there is no tenant context set (not inside an authenticated request nor a bypass)", async () => {
    const { hook } = makeFakeClient();

    await expect(
      hook({ model: "Movement", operation: "findMany", args: { where: {} }, query: jest.fn() })
    ).rejects.toThrow(/tenant context/);
  });
});

describe("tenantGuard $allOperations hook — RLS transaction wrapping (real tenant context)", () => {
  it("opens one transaction, sets app.tenant_id via set_config, and dispatches the real op to tx", async () => {
    const { hook, txCalls, executeRawCalls } = makeFakeClient();
    const args = { where: { tenantId: "t1", cidade: "São Paulo" } };

    const result = await runWithTenantContext("t1", () =>
      hook({ model: "Client", operation: "findMany", args, query: jest.fn() })
    );

    expect(result).toEqual({ ok: true });
    expect(executeRawCalls).toEqual([["t1"]]);
    // "Client" -> "client": dispatched on the tx's Prisma delegate key, not the raw model name.
    expect(txCalls).toEqual([{ model: "client", operation: "findMany", args }]);
  });

  it("accepts tenantId nested inside AND/OR, matching services/segments.ts buildGroupWhere output", async () => {
    const { hook, txCalls } = makeFakeClient();

    const orShape = { where: { tenantId: "t1", OR: [{ cidade: "São Paulo" }, { cidade: "Rio de Janeiro" }] } };
    await runWithTenantContext("t1", () => hook({ model: "Client", operation: "findMany", args: orShape, query: jest.fn() }));

    const nestedShape = { where: { AND: [{ tenantId: "t1" }, { faixaUso: "USO_ALTO" }] } };
    await runWithTenantContext("t1", () =>
      hook({ model: "Client", operation: "findMany", args: nestedShape, query: jest.fn() })
    );

    expect(txCalls).toEqual([
      { model: "client", operation: "findMany", args: orShape },
      { model: "client", operation: "findMany", args: nestedShape },
    ]);
  });

  it("does not code-guard models outside the tenant-scoped list (Movement, MessageEvent, Tenant), but still wraps them in the RLS transaction", async () => {
    const { hook, txCalls } = makeFakeClient();

    for (const [model, delegateKey] of [
      ["Movement", "movement"],
      ["MessageEvent", "messageEvent"],
      ["Tenant", "tenant"],
    ]) {
      const args = { where: { tipo: "utilizacao" } };
      const result = await runWithTenantContext("t1", () => hook({ model, operation: "findMany", args, query: jest.fn() }));
      expect(result).toEqual({ ok: true });
      expect(txCalls).toContainEqual({ model: delegateKey, operation: "findMany", args });
    }
  });

  it("leaves unguarded operations (findUnique, update, delete by id) alone at the code-level check, but still dispatches them inside the RLS transaction", async () => {
    const { hook, txCalls } = makeFakeClient();

    for (const operation of ["findUnique", "findUniqueOrThrow", "update", "delete", "upsert"]) {
      const args = { where: { id: "c1" } };
      const result = await runWithTenantContext("t1", () => hook({ model: "Client", operation, args, query: jest.fn() }));
      expect(result).toEqual({ ok: true });
      expect(txCalls).toContainEqual({ model: "client", operation, args });
    }
  });

  it("does NOT throw on create when data includes tenantId, dispatches to tx", async () => {
    const { hook, txCalls } = makeFakeClient();
    const args = { data: { tenantId: "t1", message: "oi", type: "IMPORT_FAILED" } };

    const result = await runWithTenantContext("t1", () => hook({ model: "Notification", operation: "create", args, query: jest.fn() }));

    expect(result).toEqual({ ok: true });
    expect(txCalls).toEqual([{ model: "notification", operation: "create", args }]);
  });
});

describe("withCrossTenantAccess exemption", () => {
  beforeEach(() => {
    mockAdminCalls.length = 0;
  });

  it("dispatches to the admin client (bypasses RLS entirely) for calls made inside its callback", async () => {
    const { hook, txCalls } = makeFakeClient();
    const args = { where: { active: true } };

    const result = await withCrossTenantAccess(() =>
      hook({ model: "SheetConnection", operation: "findMany", args, query: jest.fn() })
    );

    expect(result).toEqual(["admin-result"]);
    expect(mockAdminCalls).toEqual([{ model: "sheetConnection", operation: "findMany", args }]);
    // Never touches the RLS-restricted connection/transaction — a different DB role entirely.
    expect(txCalls).toHaveLength(0);
  });

  it("does not leak the bypass to calls outside the callback (doesn't accidentally exempt everything)", async () => {
    const { hook } = makeFakeClient();

    await withCrossTenantAccess(() =>
      hook({ model: "SheetConnection", operation: "findMany", args: { where: { active: true } }, query: jest.fn() })
    );

    // A call made after the bypass callback has returned, on the same guarded model/op without
    // tenantId, must still be rejected — the exemption must not persist globally.
    await expect(
      hook({ model: "SheetConnection", operation: "findMany", args: { where: { active: true } }, query: jest.fn() })
    ).rejects.toThrow(/tenantGuard/);
  });

  it("does not exempt sibling async calls that aren't inside the bypass callback", async () => {
    const { hook } = makeFakeClient();
    const guardedCall = () =>
      hook({ model: "Client", operation: "findMany", args: { where: { cidade: "x" } }, query: jest.fn() });

    // Run a real bypassed call and an unrelated guarded call concurrently — AsyncLocalStorage
    // must keep them isolated (the bypass must not "leak" across concurrent async contexts).
    const [, rejection] = await Promise.all([
      withCrossTenantAccess(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return "ok";
      }),
      guardedCall().catch((e) => e),
    ]);

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toMatch(/tenantGuard/);
  });
});

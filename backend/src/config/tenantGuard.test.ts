import {
  TENANT_SCOPED_MODELS,
  tenantGuardExtension,
  whereHasTenantId,
  withCrossTenantAccess,
} from "./tenantGuard";

/**
 * These tests exercise the guard's decision logic without touching a real database.
 *
 * Two layers are covered:
 *  1. `whereHasTenantId` directly — the pure recursive detector, including the nested
 *     AND/OR/NOT shapes that services/segments.ts actually produces (see segments.test.ts).
 *  2. The `$allOperations` hook installed by `tenantGuardExtension`, invoked the same way
 *     Prisma's extension runtime invokes it: with `{ model, operation, args, query }`, where
 *     `query` is a stub standing in for "the actual database call". Asserting the guard throws
 *     BEFORE `query` is ever called proves no network/DB call happens on the reject path, and
 *     asserting `query` DOES get called (with the same args) on the accept path proves the
 *     guard doesn't accidentally swallow or mutate legitimate queries.
 *
 * There is no existing pattern in this repo for mocking Prisma (grep confirms no `jest.mock`
 * anywhere and no DB-backed test today) — this file establishes that pattern by extracting the
 * extension's `$allOperations` function and calling it directly, rather than trying to spin up
 * a fake PrismaClient instance.
 */

// `Prisma.defineExtension` wraps a function of shape (client) => client.$extends({...}).
// Calling it with a minimal fake "client" whose only job is to hand back the extension config
// lets us reach into `query.$allModels.$allOperations` without a real PrismaClient.
function getAllOperationsHook() {
  let captured: any;
  const fakeClient = {
    $extends(config: any) {
      captured = config.query.$allModels.$allOperations;
      return config;
    },
  };
  (tenantGuardExtension as unknown as (client: any) => any)(fakeClient);
  if (typeof captured !== "function") {
    throw new Error("could not extract $allOperations hook from tenantGuardExtension");
  }
  return captured as (params: {
    model?: string;
    operation: string;
    args: any;
    query: (args: any) => Promise<any>;
  }) => Promise<any>;
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
    // Mirrors services/segments.ts buildGroupWhere: { tenantId, OR: [...] } — tenantId is a
    // sibling here, so this should already pass via the flat check, but we also verify OR
    // branches that themselves carry tenantId are detected.
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

describe("tenantGuard $allOperations hook", () => {
  it("throws on a guarded operation against a tenant-scoped model with no tenantId in where", async () => {
    const hook = getAllOperationsHook();
    const query = jest.fn().mockResolvedValue([]);

    await expect(
      hook({ model: "Client", operation: "findMany", args: { where: { cidade: "São Paulo" } }, query })
    ).rejects.toThrow(/tenantGuard/);

    // The whole point: the underlying query must never run on the reject path.
    expect(query).not.toHaveBeenCalled();
  });

  it("does NOT throw and forwards to the real query when tenantId is present", async () => {
    const hook = getAllOperationsHook();
    const args = { where: { tenantId: "t1", cidade: "São Paulo" } };
    const query = jest.fn().mockResolvedValue([{ id: "c1" }]);

    const result = await hook({ model: "Client", operation: "findMany", args, query });

    expect(result).toEqual([{ id: "c1" }]);
    expect(query).toHaveBeenCalledWith(args);
  });

  it("throws for every guarded operation, not just findMany", async () => {
    const hook = getAllOperationsHook();
    const query = jest.fn().mockResolvedValue(undefined);
    const guardedOps = [
      "findFirst",
      "findFirstOrThrow",
      "count",
      "aggregate",
      "groupBy",
      "updateMany",
      "deleteMany",
    ];

    for (const operation of guardedOps) {
      await expect(
        hook({ model: "SegmentDefinition", operation, args: { where: { name: "x" } }, query })
      ).rejects.toThrow(/tenantGuard/);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it("accepts tenantId nested inside AND/OR, matching services/segments.ts buildGroupWhere output", async () => {
    const hook = getAllOperationsHook();
    const query = jest.fn().mockResolvedValue([]);

    // Same shape buildGroupWhere("t1", { operator: "OR", groups: [...] }) produces.
    const orShape = { where: { tenantId: "t1", OR: [{ cidade: "São Paulo" }, { cidade: "Rio de Janeiro" }] } };
    await expect(hook({ model: "Client", operation: "findMany", args: orShape, query })).resolves.toEqual([]);

    // A hypothetical shape where tenantId is nested rather than a sibling should also pass.
    const nestedShape = { where: { AND: [{ tenantId: "t1" }, { faixaUso: "USO_ALTO" }] } };
    await expect(hook({ model: "Client", operation: "findMany", args: nestedShape, query })).resolves.toEqual([]);
  });

  it("does not guard models outside the tenant-scoped list (e.g. Movement, MessageEvent, Tenant)", async () => {
    const hook = getAllOperationsHook();
    const query = jest.fn().mockResolvedValue([{ id: "m1" }]);

    // Movement/MessageEvent have no tenantId column of their own (scoped via a parent relation);
    // Tenant is the tenant itself. None of these should be rejected for lacking tenantId.
    for (const model of ["Movement", "MessageEvent", "Tenant"]) {
      await expect(
        hook({ model, operation: "findMany", args: { where: { tipo: "utilizacao" } }, query })
      ).resolves.toEqual([{ id: "m1" }]);
    }
  });

  it("leaves unguarded operations (findUnique, update, delete by id) alone even without tenantId", async () => {
    const hook = getAllOperationsHook();
    const query = jest.fn().mockResolvedValue({ id: "c1" });

    for (const operation of ["findUnique", "findUniqueOrThrow", "update", "delete", "upsert"]) {
      await expect(
        hook({ model: "Client", operation, args: { where: { id: "c1" } }, query })
      ).resolves.toEqual({ id: "c1" });
    }
  });

  it("throws on create/createMany for a tenant-scoped model when data is missing tenantId", async () => {
    const hook = getAllOperationsHook();
    const query = jest.fn().mockResolvedValue({});

    await expect(
      hook({ model: "Notification", operation: "create", args: { data: { message: "oi" } }, query })
    ).rejects.toThrow(/tenantGuard/);
    expect(query).not.toHaveBeenCalled();

    await expect(
      hook({
        model: "Notification",
        operation: "createMany",
        args: { data: [{ message: "oi" }, { tenantId: "t1", message: "ok" }] },
        query,
      })
    ).rejects.toThrow(/tenantGuard/);
  });

  it("does NOT throw on create when data includes tenantId", async () => {
    const hook = getAllOperationsHook();
    const query = jest.fn().mockResolvedValue({ id: "n1" });

    await expect(
      hook({
        model: "Notification",
        operation: "create",
        args: { data: { tenantId: "t1", message: "oi", type: "IMPORT_FAILED" } },
        query,
      })
    ).resolves.toEqual({ id: "n1" });
    expect(query).toHaveBeenCalled();
  });

  describe("withCrossTenantAccess exemption", () => {
    it("bypasses the guard only for calls made inside its callback", async () => {
      const hook = getAllOperationsHook();
      const query = jest.fn().mockResolvedValue(["all-tenants-data"]);

      const result = await withCrossTenantAccess(() =>
        hook({ model: "SheetConnection", operation: "findMany", args: { where: { active: true } }, query })
      );

      expect(result).toEqual(["all-tenants-data"]);
      expect(query).toHaveBeenCalled();
    });

    it("does not leak the bypass to calls outside the callback (doesn't accidentally exempt everything)", async () => {
      const hook = getAllOperationsHook();
      const queryInBypass = jest.fn().mockResolvedValue([]);
      const queryOutsideBypass = jest.fn().mockResolvedValue([]);

      await withCrossTenantAccess(() =>
        hook({ model: "SheetConnection", operation: "findMany", args: { where: { active: true } }, query: queryInBypass })
      );

      // A call made after the bypass callback has returned, on the same guarded model/op
      // without tenantId, must still be rejected — the exemption must not persist globally.
      await expect(
        hook({ model: "SheetConnection", operation: "findMany", args: { where: { active: true } }, query: queryOutsideBypass })
      ).rejects.toThrow(/tenantGuard/);
      expect(queryOutsideBypass).not.toHaveBeenCalled();
    });

    it("does not exempt sibling async calls that aren't inside the bypass callback", async () => {
      const hook = getAllOperationsHook();
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
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TENANT_SCOPED_MODELS,
  checkRawTenant,
  runWithTenantContext,
  runWithTenantContextAsync,
  scopeArgs,
  tenantGuardExtension,
  whereHasTenantId,
  withCrossTenantAccess,
} from "./tenantGuard";

/**
 * Lógica de decisão do guard, sem banco. A prova contra um SQLite de verdade (2 tenants × models ×
 * operações) fica em tenantIsolation.int.test.ts.
 */

/** Extrai o hook `$allOperations` da extensão do mesmo jeito que o runtime do Prisma o chama. */
function hook() {
  let captured: any;
  (tenantGuardExtension as unknown as (client: any) => any)({
    $extends(config: any) {
      captured = config.query.$allModels.$allOperations;
      return config;
    },
  });
  return (model: string, operation: string, args: unknown) => {
    const query = jest.fn(async (a: unknown) => a);
    return { result: captured({ model, operation, args, query }) as Promise<any>, query };
  };
}

describe("TENANT_SCOPED_MODELS confere com o schema", () => {
  const schema = readFileSync(join(__dirname, "../../prisma/schema.prisma"), "utf8");
  const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map((m) => ({
    name: m[1],
    temTenantId: /^\s+tenantId\s+String\b/m.test(m[2]),
  }));

  it("todo model com coluna tenantId está na lista, e só eles", () => {
    expect([...TENANT_SCOPED_MODELS].sort()).toEqual(models.filter((m) => m.temTenantId).map((m) => m.name).sort());
  });

  it("o único model sem tenantId é o próprio Tenant", () => {
    expect(models.filter((m) => !m.temTenantId).map((m) => m.name)).toEqual(["Tenant"]);
  });
});

describe("scopeArgs: injeta o tenant do contexto", () => {
  it("põe tenantId no where de toda operação com where, inclusive as por id", () => {
    for (const op of ["findUnique", "findUniqueOrThrow", "findFirst", "findMany", "count", "aggregate", "groupBy", "update", "updateMany", "delete", "deleteMany"]) {
      expect(scopeArgs("Client", op, { where: { id: "c1" } }, "t1").where).toEqual({ id: "c1", tenantId: "t1" });
    }
  });

  it("cria o where quando a operação veio sem nenhum", () => {
    expect(scopeArgs("Campaign", "findMany", undefined, "t1")).toEqual({ where: { tenantId: "t1" } });
  });

  it("mantém filtros compostos (AND/OR) e acrescenta o tenant no nível de cima", () => {
    const where = { OR: [{ cidade: "Natal" }, { cidade: "Lagarto" }] };
    expect(scopeArgs("Client", "findMany", { where }, "t1").where).toEqual({ ...where, tenantId: "t1" });
  });

  it("aceita tenantId igual ao do contexto e recusa um diferente", () => {
    expect(scopeArgs("Client", "findMany", { where: { tenantId: "t1" } }, "t1").where).toEqual({ tenantId: "t1" });
    expect(() => scopeArgs("Client", "findMany", { where: { tenantId: "t2" } }, "t1")).toThrow(/tenantGuard/);
  });

  it("preenche tenantId no create e em cada item do createMany", () => {
    expect(scopeArgs("Notification", "create", { data: { message: "oi" } }, "t1").data).toEqual({ message: "oi", tenantId: "t1" });
    expect(scopeArgs("Movement", "createMany", { data: [{ tipo: "a" }, { tipo: "b", tenantId: "t1" }] }, "t1").data).toEqual([
      { tipo: "a", tenantId: "t1" },
      { tipo: "b", tenantId: "t1" },
    ]);
  });

  it("recusa create com tenantId ou relação tenant de outro tenant", () => {
    expect(() => scopeArgs("Notification", "create", { data: { tenantId: "t2" } }, "t1")).toThrow(/tenantGuard/);
    expect(() => scopeArgs("Notification", "createMany", { data: [{ tenantId: "t1" }, { tenantId: "t2" }] }, "t1")).toThrow(/tenantGuard/);
    expect(() => scopeArgs("Notification", "create", { data: { tenant: { connect: { id: "t2" } } } }, "t1")).toThrow(/tenantGuard/);
    expect(scopeArgs("Notification", "create", { data: { tenant: { connect: { id: "t1" } } } }, "t1").data).toEqual({ tenant: { connect: { id: "t1" } } });
  });

  it("upsert: where e create recebem o tenant; o update não pode trocar o tenant", () => {
    const out = scopeArgs("Merchant", "upsert", { where: { id: "m1" }, create: { name: "x" }, update: { name: "y" } }, "t1");
    expect(out).toEqual({ where: { id: "m1", tenantId: "t1" }, create: { name: "x", tenantId: "t1" }, update: { name: "y" } });
    expect(() => scopeArgs("Merchant", "upsert", { where: { id: "m1" }, create: {}, update: { tenantId: "t2" } }, "t1")).toThrow(/tenantGuard/);
  });

  it("update não pode mover a linha para outro tenant", () => {
    expect(() => scopeArgs("Client", "update", { where: { id: "c1" }, data: { tenantId: "t2" } }, "t1")).toThrow(/trocar o tenantId/);
    expect(() => scopeArgs("Client", "updateMany", { where: {}, data: { tenantId: "t2" } }, "t1")).toThrow(/trocar o tenantId/);
  });

  it("Tenant: filtra pelo id e não deixa criar nem ler outro", () => {
    expect(scopeArgs("Tenant", "findUnique", { where: { id: "t1" } }, "t1").where).toEqual({ id: "t1" });
    expect(scopeArgs("Tenant", "findMany", {}, "t1").where).toEqual({ id: "t1" });
    expect(() => scopeArgs("Tenant", "findUnique", { where: { id: "t2" } }, "t1")).toThrow(/tenantGuard/);
    expect(() => scopeArgs("Tenant", "create", { data: { name: "x" } }, "t1")).toThrow(/tenantGuard/);
    expect(() => scopeArgs("Tenant", "upsert", { where: { id: "t1" }, create: {}, update: {} }, "t1")).toThrow(/tenantGuard/);
  });

  it("falha fechada para model ou operação desconhecidos", () => {
    expect(() => scopeArgs("ModelNovo", "findMany", {}, "t1")).toThrow(/TENANT_SCOPED_MODELS/);
    expect(() => scopeArgs("Client", "operacaoNova", {}, "t1")).toThrow(/operação desconhecida/);
  });

  it("não altera o objeto recebido", () => {
    const args = { where: { id: "c1" } };
    scopeArgs("Client", "findUnique", args, "t1");
    expect(args).toEqual({ where: { id: "c1" } });
  });
});

describe("hook $allOperations", () => {
  it("sem contexto de tenant, recusa sem chegar ao banco", async () => {
    const { result, query } = hook()("Client", "findMany", { where: { tenantId: "t1" } });
    await expect(result).rejects.toThrow(/sem contexto de tenant/);
    expect(query).not.toHaveBeenCalled();
  });

  it("com contexto, despacha os argumentos já com o tenant", async () => {
    const run = hook();
    const out = await runWithTenantContext("t1", () => run("Client", "findUnique", { where: { id: "c1" } }).result);
    expect(out).toEqual({ where: { id: "c1", tenantId: "t1" } });
  });

  it("o contexto assíncrono vale para o job que processa um tenant", async () => {
    const run = hook();
    const out = await runWithTenantContextAsync("t9", async () => {
      await new Promise((r) => setTimeout(r, 1));
      return run("Purchase", "count", {}).result;
    });
    expect(out).toEqual({ where: { tenantId: "t9" } });
  });

  it("withCrossTenantAccess roda a query como veio, sem injeção", async () => {
    const run = hook();
    const args = { where: { active: true } };
    const out = await withCrossTenantAccess(() => run("SheetConnection", "findMany", args).result);
    expect(out).toBe(args);
  });

  it("o desvio não vaza para chamadas fora do callback nem para chamadas concorrentes", async () => {
    const run = hook();
    const [, fora] = await Promise.all([
      withCrossTenantAccess(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return "ok";
      }),
      run("Client", "findMany", {}).result.catch((e: Error) => e),
    ]);
    expect((fora as Error).message).toMatch(/sem contexto de tenant/);
    await expect(run("Client", "findMany", {}).result).rejects.toThrow(/sem contexto/);
  });

  it("contextos de tenants diferentes em paralelo não se misturam", async () => {
    const run = hook();
    const [a, b] = await Promise.all([
      runWithTenantContextAsync("tA", async () => {
        await new Promise((r) => setTimeout(r, 5));
        return run("Client", "findMany", {}).result;
      }),
      runWithTenantContextAsync("tB", () => run("Client", "findMany", {}).result),
    ]);
    expect(a.where.tenantId).toBe("tA");
    expect(b.where.tenantId).toBe("tB");
  });
});

describe("checkRawTenant (SQL cru)", () => {
  const sql = 'SELECT COUNT(*) FROM "Purchase" p WHERE p."tenantId" = $1 AND p."tipo" = $2';

  it("recusa sem contexto", () => {
    expect(() => checkRawTenant(sql, ["t1", "x"])).toThrow(/sem contexto/);
  });

  it("exige o tenant do contexto como 1º parâmetro", () => {
    expect(() => runWithTenantContext("t1", () => checkRawTenant(sql, ["t2", "x"]))).toThrow(/1º parâmetro/);
    expect(() => runWithTenantContext("t1", () => checkRawTenant(sql, ["t1", "x"]))).not.toThrow();
  });

  it('exige o filtro "tenantId" = $1 no SQL', () => {
    const semFiltro = 'SELECT COUNT(*) FROM "Purchase" WHERE "tipo" = $2 AND $1 IS NOT NULL';
    expect(() => runWithTenantContext("t1", () => checkRawTenant(semFiltro, ["t1", "x"]))).toThrow(/precisa filtrar/);
    expect(() => runWithTenantContext("t1", () => checkRawTenant('SELECT 1 FROM "Client" WHERE "tenantId" = $1', ["t1"]))).not.toThrow();
    // $10 não é $1
    expect(() => runWithTenantContext("t1", () => checkRawTenant('SELECT 1 WHERE "tenantId" = $10', ["t1"]))).toThrow(/precisa filtrar/);
  });

  it("dentro de withCrossTenantAccess não confere", async () => {
    await expect(withCrossTenantAccess(async () => checkRawTenant("SELECT 1", []))).resolves.toBeUndefined();
  });
});

describe("whereHasTenantId", () => {
  it("acha tenantId no topo e dentro de AND/OR/NOT", () => {
    expect(whereHasTenantId({ tenantId: "t1" })).toBe(true);
    expect(whereHasTenantId({ AND: [{ OR: [{ NOT: { tenantId: "t1" } }] }] })).toBe(true);
    expect(whereHasTenantId({ OR: [{ cidade: "x" }] })).toBe(false);
    expect(whereHasTenantId(undefined)).toBe(false);
  });
});

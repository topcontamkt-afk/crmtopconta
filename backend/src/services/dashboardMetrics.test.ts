import { clientWhere, computeKpis, rawFilterSql } from "./dashboardMetrics";

// LGPD 03-04 / 04-01: KPIs do dashboard não contam cliente anonimizado nem com tratamento bloqueado
describe("dashboardMetrics — exclusão LGPD", () => {
  it("clientWhere sempre exclui anonimizados e bloqueados, com ou sem filtro", () => {
    expect(clientWhere("t1")).toEqual({ tenantId: "t1", anonymizedAt: null, bloqueadoLgpdAt: null });
    expect(clientWhere("t1", { cidade: "Natal" })).toMatchObject({ tenantId: "t1", cidade: "Natal", anonymizedAt: null, bloqueadoLgpdAt: null });
  });

  it("rawFilterSql sempre traz a exclusão (com alias) e mantém a numeração dos parâmetros", () => {
    const sem = rawFilterSql({}, 2);
    expect(sem.sql).toBe('AND "anonymizedAt" IS NULL AND "bloqueadoLgpdAt" IS NULL');
    expect(sem.params).toEqual([]);
    const com = rawFilterSql({ cidade: "Natal", empresaConveniada: "X" }, 4, "c");
    expect(com.sql).toContain('c."anonymizedAt" IS NULL AND c."bloqueadoLgpdAt" IS NULL');
    expect(com.sql).toContain('c."cidade" = $4');
    expect(com.sql).toContain('c."empresaConveniada" = $5');
    expect(com.params).toEqual(["Natal", "X"]);
  });

  it("computeKpis usa o filtro em todas as consultas", async () => {
    const wheres: any[] = [];
    const prisma: any = {
      client: {
        count: jest.fn(async ({ where }: any) => (wheres.push(where), 0)),
        groupBy: jest.fn(async ({ where }: any) => (wheres.push(where), [])),
        aggregate: jest.fn(async ({ where }: any) => (wheres.push(where), { _sum: {}, _avg: {} })),
      },
    };
    await computeKpis(prisma, "t1");
    expect(wheres).toHaveLength(4);
    for (const w of wheres) expect(w).toMatchObject({ tenantId: "t1", anonymizedAt: null, bloqueadoLgpdAt: null });
  });
});

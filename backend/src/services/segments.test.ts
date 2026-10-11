import { buildSegmentWhere, INATIVOS_FILTERS, ENVIAVEL_WHERE, PERFIL_RENDA_PRESETS } from "./segments";

describe("buildSegmentWhere", () => {
  it("mantém compatibilidade com filtros simples (flat)", () => {
    const where = buildSegmentWhere("t1", { cidade: ["São Paulo"], faixaUso: ["USO_71_99"] });
    expect(where).toEqual({
      tenantId: "t1",
      cidade: { in: ["São Paulo"] },
      faixaUso: { in: ["USO_71_99"] },
    });
  });

  it("aplica clientIds explícitos (usado pelo motor de automação)", () => {
    const where: any = buildSegmentWhere("t1", { clientIds: ["a", "b"] });
    expect(where.id).toEqual({ in: ["a", "b"] });
  });

  it("combina grupos com OR no nível superior", () => {
    const where: any = buildSegmentWhere("t1", {
      operator: "OR",
      groups: [
        { operator: "AND", conditions: { cidade: ["São Paulo"] } },
        { operator: "AND", conditions: { cidade: ["Rio de Janeiro"] } },
      ],
    });
    expect(where.tenantId).toBe("t1");
    expect(where.OR).toHaveLength(2);
    expect(where.OR[0]).toEqual({ tenantId: "t1", cidade: { in: ["São Paulo"] } });
    expect(where.OR[1]).toEqual({ tenantId: "t1", cidade: { in: ["Rio de Janeiro"] } });
  });

  it("combina condições e sub-grupos no mesmo nível com AND", () => {
    const where: any = buildSegmentWhere("t1", {
      operator: "AND",
      conditions: { faixaUso: ["USO_71_99"] },
      groups: [{ operator: "OR", conditions: { cidade: ["São Paulo"] } }],
    });
    expect(where.AND).toHaveLength(2);
  });

  it("filtra por uso recente (usadoNosUltimosDias) — público 'recorrente'", () => {
    const before = Date.now();
    const where: any = buildSegmentWhere("t1", { usadoNosUltimosDias: 30 });
    expect(where.tenantId).toBe("t1");
    const cutoff = where.AND[0].dataUltimaUtilizacao.gte as Date;
    // cutoff deve ser ~30 dias atrás (com folga de alguns ms pelo tempo de execução do teste)
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 30 * 24 * 60 * 60 * 1000 - 1000);
    expect(cutoff.getTime()).toBeLessThanOrEqual(before - 30 * 24 * 60 * 60 * 1000 + 1000);
  });

  it("público Inativos: conta encerrada/inativa OU 90+ dias sem uso", () => {
    const where: any = buildSegmentWhere("t1", INATIVOS_FILTERS);
    expect(where.OR).toHaveLength(2);
    expect(where.OR[0].AND[0].OR).toEqual([{ encerradoEm: { not: null } }, { statusConta: "INATIVO" }]);
    expect(where.OR[1].AND[0].OR[0]).toEqual({ dataUltimaUtilizacao: null });
  });

  it("retorna apenas o filtro por tenant quando não há filtros", () => {
    expect(buildSegmentWhere("t1", undefined)).toEqual({ tenantId: "t1" });
    expect(buildSegmentWhere("t1", {})).toEqual({ tenantId: "t1" });
  });
});

describe("filtros de comércio credenciado (compras)", () => {
  it("categoriasCompra vira purchases.some com merchant.category e tenantId", () => {
    const where: any = buildSegmentWhere("t1", { categoriasCompra: ["SUPERMERCADO", "POSTO"] });
    expect(where.AND[0].purchases.some).toEqual({ tenantId: "t1", merchant: { category: { in: ["SUPERMERCADO", "POSTO"] } } });
  });

  it("só o prazo vale para qualquer compra no comércio (lojista não nulo) dentro da janela", () => {
    const where: any = buildSegmentWhere("t1", { compraNosUltimosDias: 30 });
    const some = where.AND[0].purchases.some;
    expect(some.merchantId).toEqual({ not: null });
    expect(some.occurredAt.gte).toBeInstanceOf(Date);
    expect(some.occurredAt.gte.getTime()).toBeLessThan(Date.now());
  });

  it("sem filtro de compra não adiciona condição de purchases", () => {
    const where: any = buildSegmentWhere("t1", { cidade: ["Boquim"] });
    expect(JSON.stringify(where)).not.toContain("purchases");
  });
});

describe("perfil de renda e público enviável", () => {
  it("perfilRenda vira intervalos de limite combinados com OR", () => {
    const where: any = buildSegmentWhere("t1", { perfilRenda: ["PF1", "PF4"] });
    expect(where.AND[0].OR).toEqual([
      { limiteTotal: { gt: 0, lte: 1600 } },
      { limiteTotal: { gt: 4800 } },
    ]);
  });

  it("noTetoLimite filtra o limite exatamente no teto de R$ 2.000", () => {
    const where: any = buildSegmentWhere("t1", { noTetoLimite: true });
    expect(where.AND[0]).toEqual({ limiteTotal: 2000 });
  });

  it("saldoDisponivelMin filtra por saldo mínimo", () => {
    const where: any = buildSegmentWhere("t1", { saldoDisponivelMin: 10 });
    expect(where.AND[0]).toEqual({ saldoDisponivel: { gte: 10 } });
  });

  it("ENVIAVEL_WHERE exclui quem não tem limite (comércio credenciado)", () => {
    expect(ENVIAVEL_WHERE).toEqual({ limiteTotal: { gt: 0 } });
  });

  it("os presets de perfil têm nomes únicos e filtram por perfil", () => {
    const nomes = PERFIL_RENDA_PRESETS.map((p) => p.name);
    expect(new Set(nomes).size).toBe(nomes.length);
    for (const p of PERFIL_RENDA_PRESETS) {
      const w: any = buildSegmentWhere("t1", p.filters);
      expect(JSON.stringify(w)).toContain("limiteTotal");
    }
  });
});

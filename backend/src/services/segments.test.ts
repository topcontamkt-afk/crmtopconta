import * as segments from "./segments";
import { buildSegmentWhere, INATIVOS_FILTERS, ENVIAVEL_WHERE, filtrosRendaIgnorados } from "./segments";

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

describe("LGPD 01-03: renda só como estatística, fora do público", () => {
  it("perfilRenda e noTetoLimite NÃO filtram mais (segmento antigo conta sem eles)", () => {
    const where: any = buildSegmentWhere("t1", { perfilRenda: ["PF1", "PF4"], noTetoLimite: true, cidade: ["Natal"] });
    expect(where).toEqual({ tenantId: "t1", cidade: { in: ["Natal"] } });
    expect(JSON.stringify(where)).not.toContain("limiteTotal");
  });

  it("filtrosRendaIgnorados acha o filtro de renda em qualquer nível de grupo (para a tela avisar)", () => {
    expect(filtrosRendaIgnorados({ cidade: ["Natal"] })).toEqual([]);
    expect(filtrosRendaIgnorados({ perfilRenda: [] })).toEqual([]);
    expect(filtrosRendaIgnorados({ perfilRenda: ["PF2"] })).toEqual(["perfilRenda"]);
    expect(
      filtrosRendaIgnorados({ operator: "OR", groups: [{ operator: "AND", conditions: { cidade: ["X"] } }, { operator: "AND", conditions: { noTetoLimite: true } }] })
    ).toEqual(["noTetoLimite"]);
  });

  it("não existem mais segmentos prontos de perfil de renda", () => {
    expect((segments as any).PERFIL_RENDA_PRESETS).toBeUndefined();
  });

  it("saldoDisponivelMin filtra por saldo mínimo", () => {
    const where: any = buildSegmentWhere("t1", { saldoDisponivelMin: 10 });
    expect(where.AND[0]).toEqual({ saldoDisponivel: { gte: 10 } });
  });

  it("ENVIAVEL_WHERE exclui sem limite, bloqueado (03-04), encerrado (04-06) e anonimizado (04-01)", () => {
    expect(ENVIAVEL_WHERE).toEqual({ limiteTotal: { gt: 0 }, bloqueadoLgpdAt: null, encerradoEm: null, anonymizedAt: null });
  });

  it("ENVIAVEL_WHERE não sobrescreve o filtro de segmento ao ser espalhado (só chaves de topo livres)", () => {
    const where = buildSegmentWhere("t1", { contaEncerrada: true, cidades: ["Natal"] } as any);
    const merged = { ...where, ...ENVIAVEL_WHERE };
    for (const k of Object.keys(ENVIAVEL_WHERE)) expect(where).not.toHaveProperty(k);
    expect(merged).toMatchObject({ tenantId: "t1", encerradoEm: null });
  });
});

describe("filtros de ciclo da cidade", () => {
  it("cicloAbriuHaDias vira diaCicloAbertura in [...] e não pega cliente sem ciclo", () => {
    const where: any = buildSegmentWhere("t1", { cicloAbriuHaDias: { min: 0, max: 31 } });
    expect(where.AND[0].diaCicloAbertura.in).toHaveLength(31);
    const hoje: any = buildSegmentWhere("t1", { cicloAbriuHaDias: { min: 0, max: 0 } });
    expect(hoje.AND[0].diaCicloAbertura.in).toHaveLength(1);
  });
  it("cicloAbreEmDias com faixa de 3 dias devolve 3 dias de abertura", () => {
    const where: any = buildSegmentWhere("t1", { cicloAbreEmDias: { min: 1, max: 3 } });
    expect(where.AND[0].diaCicloAbertura.in).toHaveLength(3);
  });
});

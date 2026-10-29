import { faixaAdesao, faltamParaMeta, META_ADESAO, periodoAnterior, preencheDias, resolvePeriodo, taxaAdesao, validaData, variacaoPct, variacaoPontos } from "./usoPeriodo";

describe("resolvePeriodo", () => {
  it("sem datas: últimos N dias terminando hoje", () => {
    expect(resolvePeriodo({ days: 30 }, "2026-10-17")).toEqual({ de: "2026-09-18", ate: "2026-10-17", dias: 30 });
    expect(resolvePeriodo({}, "2026-10-17")).toMatchObject({ dias: 30 });
  });
  it("só a data inicial: até hoje; só a final: N dias antes", () => {
    expect(resolvePeriodo({ de: "2026-10-01" }, "2026-10-17")).toEqual({ de: "2026-10-01", ate: "2026-10-17", dias: 17 });
    expect(resolvePeriodo({ ate: "2026-10-10", days: 7 }, "2026-10-17")).toEqual({ de: "2026-10-04", ate: "2026-10-10", dias: 7 });
  });
  it("recusa datas inválidas, invertidas e períodos longos", () => {
    expect(resolvePeriodo({ de: "2026-13-01" }, "2026-10-17")).toHaveProperty("erro");
    expect(resolvePeriodo({ de: "2026-02-30" }, "2026-10-17")).toHaveProperty("erro");
    expect(resolvePeriodo({ de: "2026-10-10", ate: "2026-10-01" }, "2026-10-17")).toHaveProperty("erro");
    expect(resolvePeriodo({ de: "2024-01-01", ate: "2026-10-01" }, "2026-10-17")).toHaveProperty("erro");
  });
  it("valida data", () => {
    expect(validaData("2026-10-17")).toBe(true);
    expect(validaData("17/10/2026")).toBe(false);
    expect(validaData(undefined)).toBe(false);
  });
});

describe("periodoAnterior e série", () => {
  it("período anterior de mesma duração, colado no atual (atravessa o mês)", () => {
    expect(periodoAnterior({ de: "2026-10-01", ate: "2026-10-10", dias: 10 })).toEqual({ de: "2026-09-21", ate: "2026-09-30", dias: 10 });
  });
  it("preenche dias sem uso com zero", () => {
    const r = preencheDias({ de: "2026-10-01", ate: "2026-10-04", dias: 4 }, [{ dia: "2026-10-02", usos: 5 }], (dia) => ({ dia, usos: 0 }));
    expect(r.map((x) => x.usos)).toEqual([0, 5, 0, 0]);
  });
  it("variação percentual", () => {
    expect(variacaoPct(150, 100)).toBe(50);
    expect(variacaoPct(50, 100)).toBe(-50);
    expect(variacaoPct(10, 0)).toBeNull();
  });
});

describe("adesão: % da base ativa que usou o saldo", () => {
  it("é usaram ÷ base ativa", () => {
    expect(taxaAdesao(669, 774)).toBe(86.4);
    expect(taxaAdesao(552, 1282)).toBe(43.1);
    expect(taxaAdesao(0, 0)).toBeNull();
  });
  it("80% ou mais é a meta; 60 a 79,9 atenção; abaixo disso fora da meta", () => {
    expect(META_ADESAO).toBe(80);
    expect(faixaAdesao(80)).toBe("SAUDAVEL");
    expect(faixaAdesao(79.8)).toBe("ATENCAO");
    expect(faixaAdesao(60)).toBe("ATENCAO");
    expect(faixaAdesao(43.1)).toBe("BAIXA");
    expect(faixaAdesao(null)).toBeNull();
  });
  it("quantos clientes faltam para chegar nos 80%", () => {
    expect(faltamParaMeta(194, 243)).toBe(1); // 80% de 243 = 194,4 -> 195
    expect(faltamParaMeta(552, 1282)).toBe(474); // 80% de 1282 = 1025,6 -> 1026
    expect(faltamParaMeta(669, 774)).toBe(0); // já passou
    expect(faltamParaMeta(0, 0)).toBe(0);
  });
  it("variação em pontos percentuais", () => {
    expect(variacaoPontos(72.5, 70)).toBe(2.5);
    expect(variacaoPontos(60, 70)).toBe(-10);
    expect(variacaoPontos(null, 70)).toBeNull();
  });
});

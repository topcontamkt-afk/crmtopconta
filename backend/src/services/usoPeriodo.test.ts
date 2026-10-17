import { periodoAnterior, preencheDias, resolvePeriodo, validaData, variacaoPct } from "./usoPeriodo";

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

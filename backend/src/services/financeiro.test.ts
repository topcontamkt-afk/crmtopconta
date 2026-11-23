import { lerMetas, periodoDoMes, progressoMeta, projetarMes, semanaDoMes, variacaoPct } from "./financeiro";

describe("periodoDoMes", () => {
  it("mês atual até o último dia do extrato; anterior cortado no mesmo dia", () => {
    expect(periodoDoMes("2026-10-15")).toMatchObject({
      mes: "2026-10",
      rotulo: "outubro de 2026",
      diaAtual: 15,
      diasNoMes: 31,
      atual: { de: "2026-10-01", ate: "2026-10-15" },
      anterior: { de: "2026-09-01", ate: "2026-09-15" },
    });
  });
  it("mês anterior mais curto limita o dia (31/03 contra fevereiro)", () => {
    expect(periodoDoMes("2026-03-31")?.anterior).toEqual({ de: "2026-02-01", ate: "2026-02-28" });
    expect(periodoDoMes("2028-03-31")?.anterior.ate).toBe("2028-02-29"); // bissexto
  });
  it("janeiro olha dezembro do ano anterior", () => {
    expect(periodoDoMes("2026-01-10")?.anterior).toEqual({ de: "2025-12-01", ate: "2025-12-10" });
  });
  it("data inválida devolve null", () => {
    expect(periodoDoMes("2026-02-30")).toBeNull();
    expect(periodoDoMes("2026-13-01")).toBeNull();
    expect(periodoDoMes("lixo")).toBeNull();
  });
});

describe("semanaDoMes", () => {
  it("1–7, 8–14, 15–21 e 22 em diante", () => {
    expect([1, 7, 8, 14, 15, 21, 22, 31].map(semanaDoMes)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  });
});

describe("variacaoPct", () => {
  it("calcula e arredonda; sem base é null", () => {
    expect(variacaoPct(110, 100)).toBe(10);
    expect(variacaoPct(90, 100)).toBe(-10);
    expect(variacaoPct(10, 0)).toBeNull();
  });
});

describe("projetarMes", () => {
  it("linear: R$ 48.300 no dia 23 de 30 projeta ~R$ 63 mil", () => {
    const p = projetarMes(48300, 23, 30, true);
    expect(p.valor).toBe(63000);
    expect(p.confianca).toBe("alta");
  });
  it("poucos dias de mês: confiança baixa; meio de mês: média", () => {
    expect(projetarMes(1000, 3, 30, true).confianca).toBe("baixa");
    expect(projetarMes(1000, 10, 30, true).confianca).toBe("media");
  });
  it("extrato parado rebaixa a confiança um nível", () => {
    expect(projetarMes(1000, 20, 30, false).confianca).toBe("media");
    expect(projetarMes(1000, 10, 30, false).confianca).toBe("baixa");
  });
  it("mês fechado: o projetado é o acumulado", () => {
    expect(projetarMes(5000, 30, 30, true)).toEqual({ valor: 5000, confianca: "alta" });
  });
});

describe("progressoMeta e lerMetas", () => {
  it("progresso em % e atingida; sem meta é null", () => {
    expect(progressoMeta(48300, 60000)).toEqual({ pct: 80.5, atingida: false });
    expect(progressoMeta(60000, 60000)?.atingida).toBe(true);
    expect(progressoMeta(10, null)).toBeNull();
    expect(progressoMeta(10, 0)).toBeNull();
  });
  it("metas inválidas viram null", () => {
    expect(lerMetas({ lucro: 60000, usos: "x" })).toEqual({ lucro: 60000, usos: null });
    expect(lerMetas(null)).toEqual({ lucro: null, usos: null });
    expect(lerMetas({ lucro: -5, usos: NaN })).toEqual({ lucro: null, usos: null });
  });
});

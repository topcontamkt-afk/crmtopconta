import { calculatePercentualUtilizado, categorizeFaixa, computeUsage } from "./usage";

describe("calculatePercentualUtilizado", () => {
  it("calcula o percentual corretamente", () => {
    expect(calculatePercentualUtilizado(1000, 500)).toBe(50);
    expect(calculatePercentualUtilizado(1000, 1000)).toBe(100);
    expect(calculatePercentualUtilizado(1000, 0)).toBe(0);
  });

  it("evita divisão por zero quando limite_total é 0 ou negativo", () => {
    expect(calculatePercentualUtilizado(0, 500)).toBe(0);
    expect(calculatePercentualUtilizado(-100, 500)).toBe(0);
  });

  it("arredonda para 2 casas decimais", () => {
    expect(calculatePercentualUtilizado(3, 1)).toBe(33.33);
  });
});

describe("categorizeFaixa", () => {
  it("marca como INDEFINIDO quando não há limite cadastrado", () => {
    expect(categorizeFaixa(0, 0)).toBe("INDEFINIDO");
  });

  it("classifica as faixas de forma mutuamente exclusiva e determinística", () => {
    expect(categorizeFaixa(0, 1000)).toBe("NAO_UTILIZOU");
    expect(categorizeFaixa(10, 1000)).toBe("BAIXO_USO");
    expect(categorizeFaixa(30, 1000)).toBe("USO_INICIAL");
    expect(categorizeFaixa(60, 1000)).toBe("USO_INTERMEDIARIO");
    expect(categorizeFaixa(85, 1000)).toBe("USO_ALTO");
    expect(categorizeFaixa(95, 1000)).toBe("QUASE_COMPLETO");
    expect(categorizeFaixa(100, 1000)).toBe("LIMITE_COMPLETO");
  });
});

describe("computeUsage", () => {
  it("combina percentual e faixa consistentemente", () => {
    expect(computeUsage(2000, 1800)).toEqual({ percentual: 90, faixa: "QUASE_COMPLETO" });
  });
});

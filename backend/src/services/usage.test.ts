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
    expect(categorizeFaixa(0, 1000)).toBe("SEM_USO");
    expect(categorizeFaixa(0.5, 1000)).toBe("USO_1_10");
    expect(categorizeFaixa(10, 1000)).toBe("USO_1_10");
    expect(categorizeFaixa(10.01, 1000)).toBe("USO_11_20");
    expect(categorizeFaixa(20, 1000)).toBe("USO_11_20");
    expect(categorizeFaixa(25, 1000)).toBe("USO_21_30");
    expect(categorizeFaixa(30, 1000)).toBe("USO_21_30");
    expect(categorizeFaixa(31, 1000)).toBe("USO_31_50");
    expect(categorizeFaixa(50, 1000)).toBe("USO_31_50");
    expect(categorizeFaixa(51, 1000)).toBe("USO_51_70");
    expect(categorizeFaixa(70, 1000)).toBe("USO_51_70");
    expect(categorizeFaixa(70.5, 1000)).toBe("USO_71_99");
    expect(categorizeFaixa(99.99, 1000)).toBe("USO_71_99");
    expect(categorizeFaixa(100, 1000)).toBe("USO_100");
    expect(categorizeFaixa(130, 1000)).toBe("USO_100");
  });
});

describe("computeUsage", () => {
  it("combina percentual e faixa consistentemente", () => {
    expect(computeUsage(2000, 1800)).toEqual({ percentual: 90, faixa: "USO_71_99" });
  });
});

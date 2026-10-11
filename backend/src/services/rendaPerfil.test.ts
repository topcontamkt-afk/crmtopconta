import {
  classificarPerfil,
  estimarSalario,
  isNoTeto,
  LIMITE_MAXIMO,
  limiteRange,
  PERFIS_RENDA,
} from "./rendaPerfil";

describe("estimarSalario", () => {
  it("é o limite dividido por 0,40", () => {
    expect(estimarSalario(2000)).toBe(5000);
    expect(estimarSalario(1600)).toBe(4000);
    expect(estimarSalario(1897.52)).toBe(4743.8);
  });

  it("aceita Decimal/texto do banco", () => {
    expect(estimarSalario("2000")).toBe(5000);
    expect(estimarSalario({ toString: () => "800" } as any)).toBe(2000);
  });

  it("sem limite (comércio credenciado) não tem salário estimado", () => {
    expect(estimarSalario(0)).toBeNull();
    expect(estimarSalario(null)).toBeNull();
    expect(estimarSalario(undefined)).toBeNull();
    expect(estimarSalario(-5)).toBeNull();
  });
});

describe("classificarPerfil — cortes do cliente", () => {
  it("PF1 vai até R$ 4.000 de salário (limite R$ 1.600), inclusive", () => {
    expect(classificarPerfil(1600)).toBe("PF1");
    expect(classificarPerfil(1599.99)).toBe("PF1");
  });

  it("PF2 começa um centavo depois e vai até R$ 8.000 (limite R$ 3.200)", () => {
    expect(classificarPerfil(1600.01)).toBe("PF2");
    expect(classificarPerfil(3200)).toBe("PF2");
  });

  it("PF3 vai até R$ 12.000 (limite R$ 4.800)", () => {
    expect(classificarPerfil(3200.01)).toBe("PF3");
    expect(classificarPerfil(4800)).toBe("PF3");
  });

  it("PF4 começa depois de R$ 12.000, e acima de R$ 100.000 também é PF4", () => {
    expect(classificarPerfil(4800.01)).toBe("PF4");
    expect(classificarPerfil(40000)).toBe("PF4");
    expect(classificarPerfil(99999)).toBe("PF4");
  });

  it("quem estaria abaixo do piso de R$ 1.621 entra no PF1 (decisão do cliente)", () => {
    expect(classificarPerfil(648.39)).toBe("PF1");
    expect(classificarPerfil(355)).toBe("PF1");
    expect(classificarPerfil(10)).toBe("PF1");
  });

  it("sem limite não tem perfil: é comércio credenciado", () => {
    expect(classificarPerfil(0)).toBeNull();
    expect(classificarPerfil(null)).toBeNull();
  });

  it("o teto de R$ 2.000 fica no PF2 e é marcado como teto", () => {
    expect(classificarPerfil(2000)).toBe("PF2");
    expect(isNoTeto(2000)).toBe(true);
    expect(isNoTeto("2000.00")).toBe(true);
    expect(isNoTeto(1999.99)).toBe(false);
    expect(isNoTeto(2000.5)).toBe(false);
  });
});

describe("limiteRange — o filtro do banco concorda com a classificação", () => {
  const amostra = [0.01, 10, 355, 648.4, 1599.99, 1600, 1600.01, 2000, 3199.99, 3200, 3200.01, 4598.66, 4800, 4800.01, 40000, 99999];

  it("cada limite positivo cai em exatamente um intervalo, o do seu perfil", () => {
    for (const l of amostra) {
      const donos = PERFIS_RENDA.filter((p) => {
        const r = limiteRange(p);
        return l > r.gt && (r.lte === undefined || l <= r.lte);
      });
      expect(donos).toEqual([classificarPerfil(l)]);
    }
  });

  it("os intervalos não têm buraco nem sobreposição entre perfis vizinhos", () => {
    expect(limiteRange("PF1").lte).toBe(limiteRange("PF2").gt);
    expect(limiteRange("PF2").lte).toBe(limiteRange("PF3").gt);
    expect(limiteRange("PF3").lte).toBe(limiteRange("PF4").gt);
    expect(limiteRange("PF1").gt).toBe(0);
    expect(limiteRange("PF4").lte).toBeUndefined();
  });

  it("os tetos de limite são os salários do cliente vezes 0,40", () => {
    expect(LIMITE_MAXIMO).toEqual({ PF1: 1600, PF2: 3200, PF3: 4800 });
  });
});

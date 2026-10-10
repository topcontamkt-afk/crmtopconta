import { bandFor, computeHealth } from "./health";

describe("computeHealth", () => {
  it("retorna null para base vazia em vez de inventar uma nota", () => {
    expect(computeHealth({ total: 0, ativos: 0, semUso: 0, bloqueados: 0, limiteTotal: 0, valorUtilizado: 0 })).toBeNull();
  });

  it("dá 100 para uma base que bate todas as metas", () => {
    const r = computeHealth({ total: 100, ativos: 60, semUso: 0, bloqueados: 0, limiteTotal: 1000, valorUtilizado: 400 })!;
    expect(r.score).toBe(100);
    expect(r.band).toBe("SAUDAVEL");
  });

  it("limita cada componente a 100 (acima da meta não passa de nota cheia)", () => {
    const r = computeHealth({ total: 100, ativos: 100, semUso: 0, bloqueados: 0, limiteTotal: 1000, valorUtilizado: 1000 })!;
    expect(r.score).toBe(100);
    expect(r.components.every((c) => c.nota <= 100)).toBe(true);
  });

  it("base quase toda inativa cai em Atenção/Crítico e expõe os componentes", () => {
    // Cenário parecido com a base real: 14 ativos de 370, 40 sem uso, ~20,8% do limite em uso.
    const r = computeHealth({ total: 370, ativos: 14, semUso: 40, bloqueados: 0, limiteTotal: 77708.38, valorUtilizado: 16191.19 })!;
    expect(r.score).toBeGreaterThanOrEqual(40);
    expect(r.score).toBeLessThan(70);
    expect(r.band).toBe("ATENCAO");
    const ativacao = r.components.find((c) => c.key === "ativacao")!;
    expect(ativacao.valor).toBeCloseTo(3.8, 1);
    expect(ativacao.nota).toBeLessThan(10);
  });

  it("limite zero não gera divisão por zero: uso do limite vale 0", () => {
    const r = computeHealth({ total: 10, ativos: 5, semUso: 5, bloqueados: 0, limiteTotal: 0, valorUtilizado: 0 })!;
    expect(r.components.find((c) => c.key === "usoLimite")!.nota).toBe(0);
    expect(Number.isFinite(r.score)).toBe(true);
  });

  it("bloqueados reduzem a regularidade", () => {
    const r = computeHealth({ total: 100, ativos: 60, semUso: 0, bloqueados: 50, limiteTotal: 1000, valorUtilizado: 400 })!;
    expect(r.components.find((c) => c.key === "regularidade")!.nota).toBe(50);
  });
});

describe("alcance e clientes sem limite", () => {
  it("ignora clientes INDEFINIDOS no alcance (não conta como 'já usaram')", () => {
    const r = computeHealth({ total: 100, ativos: 10, semUso: 10, indefinidos: 80, bloqueados: 0, limiteTotal: 1000, valorUtilizado: 100 })!;
    // 20 clientes com limite, 10 sem uso => alcance 50%
    expect(r.components.find((c) => c.key === "alcance")!.valor).toBe(50);
  });

  it("todos sem limite => alcance 0, sem NaN", () => {
    const r = computeHealth({ total: 10, ativos: 0, semUso: 0, indefinidos: 10, bloqueados: 0, limiteTotal: 0, valorUtilizado: 0 })!;
    expect(r.components.find((c) => c.key === "alcance")!.nota).toBe(0);
    expect(Number.isFinite(r.score)).toBe(true);
  });
});

describe("bandFor", () => {
  it("respeita os limiares 40 e 70", () => {
    expect(bandFor(39).band).toBe("CRITICO");
    expect(bandFor(40).band).toBe("ATENCAO");
    expect(bandFor(69).band).toBe("ATENCAO");
    expect(bandFor(70).band).toBe("SAUDAVEL");
  });
});

import { AMOSTRA_MINIMA, FotoInsight, buildMelhorouCaiu, confiancaDe, prioridadeDe } from "./insights";

const base: FotoInsight = {
  totalClientes: 1000,
  ativos: 500,
  inativos: 400,
  semUso: 300,
  indefinidos: 50,
  usoLimitePct: 40,
  score: 60,
};
const foto = (p: Partial<FotoInsight>): FotoInsight => ({ ...base, ...p });

describe("buildMelhorouCaiu", () => {
  it("classifica por direção: ativos subindo melhora, inativos subindo piora", () => {
    const r = buildMelhorouCaiu(foto({ ativos: 560, inativos: 440 }), base, 30);
    expect(r.melhorou.map((i) => i.key)).toContain("ativosPct");
    expect(r.caiu.map((i) => i.key)).toContain("inativosPct");
  });

  it("mudança abaixo do mínimo da métrica conta como estável, não vira insight", () => {
    const r = buildMelhorouCaiu(foto({ ativos: 505 }), base, 30); // +0,5 pp < 1 pp
    expect(r.melhorou.find((i) => i.key === "ativosPct")).toBeUndefined();
    expect(r.estaveis).toBeGreaterThan(0);
  });

  it("variação de ativos em pontos percentuais, não em contagem bruta", () => {
    // base dobrou, mas a fatia de ativos não mudou: nada a reportar
    const r = buildMelhorouCaiu(foto({ totalClientes: 2000, ativos: 1000, inativos: 800, semUso: 600, indefinidos: 100 }), base, 30);
    expect(r.melhorou).toHaveLength(0);
    expect(r.caiu).toHaveLength(0);
  });

  it("amostra pequena: nada é avaliado e o motivo vem explícito", () => {
    const r = buildMelhorouCaiu(foto({ totalClientes: AMOSTRA_MINIMA - 1 }), base, 30);
    expect(r.indisponivel).toBe("AMOSTRA_PEQUENA");
    expect(r.melhorou).toHaveLength(0);
    expect(r.caiu).toHaveLength(0);
  });

  it("métrica sem um dos lados (nota ou uso do limite null) é omitida", () => {
    const r = buildMelhorouCaiu(foto({ score: null, usoLimitePct: null }), base, 30);
    const keys = [...r.melhorou, ...r.caiu].map((i) => i.key);
    expect(keys).not.toContain("score");
    expect(keys).not.toContain("usoLimitePct");
  });

  it("nota de saúde: subir 6 pontos melhora, com variação em pts", () => {
    const r = buildMelhorouCaiu(foto({ score: 66 }), base, 30);
    const nota = r.melhorou.find((i) => i.key === "score");
    expect(nota).toMatchObject({ unidade: "pts", abs: 6, atual: 66, anterior: 60 });
  });

  it("clientes sem limite subindo vira alerta com ação para importações", () => {
    const r = buildMelhorouCaiu(foto({ indefinidos: 140 }), base, 30); // 5% -> 14%
    const item = r.caiu.find((i) => i.key === "semLimitePct");
    expect(item?.acao?.destino).toBe("/imports");
  });

  it("ordena pelos mais relevantes e limita a 5 por lado", () => {
    const r = buildMelhorouCaiu(foto({ ativos: 700, inativos: 200, semUso: 100, indefinidos: 0, usoLimitePct: 60, score: 80 }), base, 30);
    expect(r.melhorou.length).toBeLessThanOrEqual(5);
    const prioridades = r.melhorou.map((i) => i.prioridade);
    expect(prioridades).toEqual([...prioridades].sort((a, b) => b - a));
  });
});

describe("confiancaDe e prioridadeDe", () => {
  it("confiança cresce com histórico e tamanho da base", () => {
    expect(confiancaDe(30, 1000)).toBe("alta");
    expect(confiancaDe(7, 100)).toBe("media");
    expect(confiancaDe(2, 1000)).toBe("baixa");
  });
  it("prioridade fica entre 1 e 5", () => {
    expect(prioridadeDe(1, 1)).toBe(2);
    expect(prioridadeDe(0.1, 1)).toBe(1);
    expect(prioridadeDe(100, 1)).toBe(5);
  });
});

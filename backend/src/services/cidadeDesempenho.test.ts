import { avaliarCidades, CidadeEntrada } from "./cidadeDesempenho";

const cid = (p: Partial<CidadeEntrada> & { cidadeKey: string }): CidadeEntrada => ({
  cidade: p.cidadeKey,
  clientes: 1000,
  inativos: 300,
  usaramAtual: 300,
  usaramAnterior: 300,
  usosAtual: 600,
  usosAnterior: 600,
  abreEmDias: null,
  ...p,
});

describe("avaliarCidades", () => {
  it("cidade pequena ou com poucos usos vira 'poucos dados' e nunca é destaque nem atenção", () => {
    const r = avaliarCidades([cid({ cidadeKey: "a" }), cid({ cidadeKey: "pequena", clientes: 10, usaramAtual: 9, usaramAnterior: 1 }), cid({ cidadeKey: "semuso", usosAtual: 5, usosAnterior: 5 })]);
    expect(r.cidades.find((c) => c.cidadeKey === "pequena")?.situacao).toBe("poucos_dados");
    expect(r.cidades.find((c) => c.cidadeKey === "semuso")?.situacao).toBe("poucos_dados");
    expect(r.cidades.find((c) => c.cidadeKey === "pequena")?.taxaUso).toBeNull();
  });

  it("queda forte de uso vira atenção, com motivo e clientes em jogo", () => {
    const r = avaliarCidades([cid({ cidadeKey: "ok" }), cid({ cidadeKey: "lagarto", usaramAtual: 200, usaramAnterior: 300 })]);
    const l = r.cidades.find((c) => c.cidadeKey === "lagarto")!;
    expect(l).toMatchObject({ situacao: "atencao", variacaoPp: -10, clientesEmJogo: 100 });
    expect(r.precisaAtencao?.cidadeKey).toBe("lagarto");
  });

  it("alta de uso acima da mediana é destaque; alta abaixo da mediana não", () => {
    const sobe = avaliarCidades([cid({ cidadeKey: "x" }), cid({ cidadeKey: "y" }), cid({ cidadeKey: "natal", usaramAtual: 380, usaramAnterior: 300 })]);
    expect(sobe.emDestaque?.cidadeKey).toBe("natal");
    const abaixo = avaliarCidades([cid({ cidadeKey: "x", usaramAtual: 500, usaramAnterior: 500 }), cid({ cidadeKey: "y", usaramAtual: 500, usaramAnterior: 500 }), cid({ cidadeKey: "z", usaramAtual: 130, usaramAnterior: 90 })]);
    expect(abaixo.emDestaque).toBeNull();
  });

  it("uso muito abaixo da mediana é atenção mesmo sem queda", () => {
    const r = avaliarCidades([cid({ cidadeKey: "x" }), cid({ cidadeKey: "y" }), cid({ cidadeKey: "baixo", usaramAtual: 100, usaramAnterior: 100 })]);
    expect(r.cidades.find((c) => c.cidadeKey === "baixo")?.situacao).toBe("atencao");
  });

  it("queda moderada fica em observar e variação pequena é estável", () => {
    const r = avaliarCidades([cid({ cidadeKey: "x" }), cid({ cidadeKey: "obs", usaramAtual: 270, usaramAnterior: 300 }), cid({ cidadeKey: "est", usaramAtual: 305, usaramAnterior: 300 })]);
    expect(r.cidades.find((c) => c.cidadeKey === "obs")?.situacao).toBe("observar");
    expect(r.cidades.find((c) => c.cidadeKey === "est")?.situacao).toBe("estavel");
  });

  it("sem cidade avaliável não há destaque nem atenção e a mediana é null", () => {
    const r = avaliarCidades([cid({ cidadeKey: "p", clientes: 5 })]);
    expect(r).toMatchObject({ emDestaque: null, precisaAtencao: null, mediana: null });
  });

  it("ordena atenção primeiro, pelo maior número de clientes em jogo", () => {
    const r = avaliarCidades([
      cid({ cidadeKey: "ok" }),
      cid({ cidadeKey: "pequena_queda", clientes: 100, usaramAtual: 20, usaramAnterior: 30, usosAtual: 20, usosAnterior: 30 }),
      cid({ cidadeKey: "grande_queda", usaramAtual: 200, usaramAnterior: 300 }),
    ]);
    expect(r.cidades[0].cidadeKey).toBe("grande_queda");
  });
});

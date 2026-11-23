import { avaliarConvenios, ConvenioEntrada } from "./convenioDesempenho";

const conv = (p: Partial<ConvenioEntrada> & { chave: string }): ConvenioEntrada => ({
  convenio: p.chave,
  clientes: 1000,
  inativos: 300,
  usaramAtual: 300,
  usaramAnterior: 300,
  usosAtual: 600,
  usosAnterior: 600,
  lucroAtual: 3000,
  lucroAnterior: 3000,
  ...p,
});

describe("avaliarConvenios", () => {
  it("usa a mesma classificação das cidades (queda forte = atenção)", () => {
    const r = avaliarConvenios([conv({ chave: "ok" }), conv({ chave: "edu", convenio: "Educação", usaramAtual: 200 })]);
    expect(r.precisaAtencao).toMatchObject({ chave: "edu", convenio: "Educação", situacao: "atencao", variacaoPp: -10 });
  });

  it("variação do lucro em % e sem base anterior fica null", () => {
    const r = avaliarConvenios([conv({ chave: "a", lucroAtual: 3300, lucroAnterior: 3000 }), conv({ chave: "b", lucroAnterior: 0 })]);
    expect(r.convenios.find((c) => c.chave === "a")?.lucroVariacaoPct).toBe(10);
    expect(r.convenios.find((c) => c.chave === "b")?.lucroVariacaoPct).toBeNull();
  });

  it("potencial: 10% dos inativos rendendo como quem usou; sem base suficiente é null", () => {
    // lucro por usuário = 3000/300 = 10; 10% de 300 inativos = 30 clientes -> R$ 300
    const r = avaliarConvenios([conv({ chave: "a" }), conv({ chave: "poucos", usaramAtual: 5, usaramAnterior: 5, usosAtual: 20, usosAnterior: 20 }), conv({ chave: "semlucro", lucroAtual: 0 })]);
    expect(r.convenios.find((c) => c.chave === "a")?.potencial10pct).toBe(300);
    expect(r.convenios.find((c) => c.chave === "poucos")?.potencial10pct).toBeNull();
    expect(r.convenios.find((c) => c.chave === "semlucro")?.potencial10pct).toBeNull();
  });

  it("convênio pequeno é 'poucos dados' e não aparece como destaque/atenção", () => {
    const r = avaliarConvenios([conv({ chave: "ok" }), conv({ chave: "mini", clientes: 10 })]);
    expect(r.convenios.find((c) => c.chave === "mini")?.situacao).toBe("poucos_dados");
  });

  it("sem entradas devolve estrutura vazia", () => {
    expect(avaliarConvenios([])).toEqual({ convenios: [], emDestaque: null, precisaAtencao: null, mediana: null });
  });
});

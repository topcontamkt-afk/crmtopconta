import { adaptarCidades, adaptarConvenios, adaptarFinanceiro, adaptarHorarios, adaptarOportunidades, CAMPOS_PESSOAIS, CAMPOS_PROIBIDOS, sanitizar } from "./adaptadores";

/** Procura, em qualquer profundidade, uma chave que o assistente não pode enxergar. */
function chavesProibidas(v: unknown, achadas: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => chavesProibidas(x, achadas));
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      if (CAMPOS_PROIBIDOS.has(k) || CAMPOS_PESSOAIS.test(k)) achadas.push(k);
      chavesProibidas(x, achadas);
    }
  return achadas;
}

describe("sanitizar", () => {
  it("remove projeção, estimativa e dados pessoais em qualquer profundidade", () => {
    const r = sanitizar({
      total: 10,
      projecao: { lucro: { valor: 1 } },
      lista: [{ nome: "Maria", telefone: "+5579", cidade: "Natal", potencial10pct: 5 }],
      aninhado: { cpf: "1", cpfMasked: "***", email: "a@b.c", sugestao: { horario: "11:20" }, ok: true },
    });
    expect(chavesProibidas(r)).toEqual([]);
    expect(r).toEqual({ total: 10, lista: [{ cidade: "Natal" }], aninhado: { ok: true } });
  });

  it("limita listas longas e avisa quantos itens ficaram de fora", () => {
    const r = sanitizar({ itens: Array.from({ length: 100 }, (_, i) => ({ i })) });
    expect(r.itens).toHaveLength(41);
    expect(r.itens[40]).toEqual({ _itensOmitidos: 60 });
  });

  it("corta textos muito longos", () => {
    expect(sanitizar({ t: "x".repeat(2000) }).t.length).toBeLessThan(600);
  });
});

describe("adaptadores", () => {
  it("financeiro: sem projeção do fechamento, mantendo o acumulado e as metas", () => {
    const r = adaptarFinanceiro({
      disponivel: true, atual: { lucro: 100 }, anterior: { lucro: 80 }, metas: { lucro: 500 }, progresso: { lucro: { pct: 20 } },
      projecao: { lucro: { valor: 300, confianca: "media" } },
    });
    expect(r.projecao).toBeUndefined();
    expect(r.atual.lucro).toBe(100);
    expect(r.progresso.lucro.pct).toBe(20);
    expect(JSON.stringify(r)).not.toMatch(/proje/i);
  });

  it("horários: sem horário sugerido; antecedência só quando foi medida de verdade", () => {
    const base = {
      disponivel: true, periodo: { ate: "2026-10-15", dias: 90 }, extratoEmDia: false,
      total: { usos: 100, porHora: [1, 2], picoHora: 12, sugestao: { horario: "11:20" } },
      segmentos: [{ key: "PF1", label: "PF1", clientes: 10, usos: 50, porHora: [1], picoHora: 12, poucosDados: false, sugestao: { horario: "11:20" } }],
    };
    const padrao = adaptarHorarios({ ...base, antecedencia: { fonte: "padrao", medianaMin: 30, p25Min: null, p75Min: null, amostra: 3 } });
    expect(padrao.tempoMedidoEnvioAtePrimeiroUso).toBeNull();
    expect(JSON.stringify(padrao)).not.toMatch(/11:20|sugest/i);
    expect(padrao.total.picoHora).toBe(12);
    const medida = adaptarHorarios({ ...base, antecedencia: { fonte: "medida", medianaMin: 40, p25Min: 25, p75Min: 70, amostra: 80 } });
    expect(medida.tempoMedidoEnvioAtePrimeiroUso).toEqual({ mediana_min: 40, p25_min: 25, p75_min: 70, envios_medidos: 80 });
  });

  it("convênios: sem potencial estimado nem destaques calculados", () => {
    const r = adaptarConvenios({
      disponivel: true, semConvenio: { n: 1, pct: 1 }, mediana: 40, emDestaque: { convenio: "A" }, precisaAtencao: { convenio: "B" },
      convenios: [{ convenio: "A", clientes: 5, inativos: 1, taxaUso: 40, variacaoPp: 2, situacao: "estavel", lucroAtual: 10, lucroAnterior: 8, lucroVariacaoPct: 25, potencial10pct: 99, clientesEmJogo: 4 }],
    });
    expect(chavesProibidas(r)).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(/potencial|emJogo/i);
    expect(r.convenios[0].lucroVariacaoPct).toBe(25);
  });

  it("cidades: taxa de uso e variação observadas, sem 'clientes em jogo'", () => {
    const r = adaptarCidades({
      disponivel: true, ultimoDiaExtrato: "2026-10-15", extratoEmDia: false, diasDefasagem: 38, mediana: 50, emDestaque: { cidade: "X" },
      cidades: [{ cidadeKey: "natal", cidade: "Natal", clientes: 100, inativos: 10, usaramAtual: 50, usaramAnterior: 40, taxaUso: 50, taxaUsoAnterior: 40, variacaoPp: 10, situacao: "destaque", clientesEmJogo: 7, abreEmDias: 3 }],
    });
    expect(chavesProibidas(r)).toEqual([]);
    expect(r.cidades[0]).toMatchObject({ cidade: "Natal", taxaUsoPct: 50, variacaoPp: 10, diasParaAbrirCiclo: 3 });
  });

  it("oportunidades: contagens e variação, sem texto de campanha", () => {
    const r = adaptarOportunidades({
      totalClientes: 100, comLimite: 90, historicoDisponivel: true,
      faixas: [{ key: "uso_0", range: "0%", label: "Sem uso", n: 10, mensagem: "Olá {{nome}}", tendencia: { dias: 10, anterior: 12, atual: 10, pct: -16.7, direcao: "caiu", efeito: "melhora", leitura: "..." } }],
      itens: [{ key: "inativos", titulo: "Inativos", grupo: "Ativação", n: 30, status: "campanha", mensagem: "Sentimos sua falta", desc: "texto", tendencia: null }],
    });
    expect(JSON.stringify(r)).not.toMatch(/Olá|Sentimos|texto/);
    expect(r.faixasDeUsoDoLimite[0]).toMatchObject({ clientes: 10, variacao: { variacao_pct: -16.7, direcao: "caiu" } });
    expect(r.publicos[0]).toMatchObject({ chave: "inativos", clientes: 30 });
  });
});

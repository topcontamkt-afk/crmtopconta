/**
 * O que o assistente enxerga. Duas barreiras antes de qualquer resultado chegar ao modelo:
 *  - nada de projeção, previsão ou estimativa (campos proibidos abaixo): o assistente só informa o que aconteceu;
 *  - nada de dado pessoal de cliente (nome, telefone, CPF, e-mail).
 * Testado em adaptadores.test.ts, que também varre o resultado em busca desses campos.
 */

/** Campos que carregam projeção, previsão, estimativa ou nota de risco: nunca vão para o modelo. */
export const CAMPOS_PROIBIDOS = new Set([
  "projecao",
  "potencial10pct",
  "clientesEmJogo",
  "sugestao",
  "lucroMensalEmRisco",
  "nota",
  "nivel",
  "emDestaque",
  "precisaAtencao",
]);

/** Campos de dado pessoal. */
export const CAMPOS_PESSOAIS = /^(nome|telefone|phone|cpf|cpfhash|cpfmasked|email|waid|documento)$/i;

const MAX_ITENS = 40;
const MAX_TEXTO = 500;

/** Remove campos proibidos e pessoais, limita listas e textos. Recursivo. */
export function sanitizar<T>(valor: T): T {
  return limpar(valor) as T;
}

function limpar(v: unknown): unknown {
  if (Array.isArray(v)) {
    const itens = v.slice(0, MAX_ITENS).map(limpar);
    return v.length > MAX_ITENS ? [...itens, { _itensOmitidos: v.length - MAX_ITENS }] : itens;
  }
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (CAMPOS_PROIBIDOS.has(k) || CAMPOS_PESSOAIS.test(k)) continue;
      out[k] = limpar(x);
    }
    return out;
  }
  if (typeof v === "string") return v.length > MAX_TEXTO ? `${v.slice(0, MAX_TEXTO)}…` : v;
  return v;
}

type Obj = Record<string, any>;

/** Horários: só o que foi medido. A antecedência só aparece quando vem de envios reais medidos (não do padrão assumido). */
export function adaptarHorarios(d: Obj): Obj {
  if (!d?.disponivel) return d;
  const { antecedencia, total, segmentos, ...resto } = d;
  return {
    ...resto,
    total: total ? { usos: total.usos, porHora: total.porHora, picoHora: total.picoHora } : null,
    segmentos: (segmentos ?? []).map((s: Obj) => ({ chave: s.key, rotulo: s.label, clientes: s.clientes, usos: s.usos, porHora: s.porHora, picoHora: s.picoHora })),
    tempoMedidoEnvioAtePrimeiroUso:
      antecedencia?.fonte === "medida"
        ? { mediana_min: antecedencia.medianaMin, p25_min: antecedencia.p25Min, p75_min: antecedencia.p75Min, envios_medidos: antecedencia.amostra }
        : null,
    observacao: "porHora tem 24 posições (0h a 23h, horário de Brasília); picoHora é a hora com mais usos registrados.",
  };
}

/** Oportunidades: contagens e variação observada, sem textos de campanha. */
export function adaptarOportunidades(d: Obj): Obj {
  const t = (x: Obj | null | undefined) =>
    x ? { dias: x.dias, anterior: x.anterior, atual: x.atual, variacao_pct: x.pct, direcao: x.direcao } : null;
  return {
    totalClientes: d.totalClientes,
    comLimite: d.comLimite,
    historicoDisponivel: d.historicoDisponivel,
    faixasDeUsoDoLimite: (d.faixas ?? []).map((b: Obj) => ({ faixa: b.range, rotulo: b.label, clientes: b.n, variacao: t(b.tendencia) })),
    publicos: (d.itens ?? []).map((i: Obj) => ({ chave: i.key, titulo: i.titulo, grupo: i.grupo, clientes: i.n, tipo: i.status, variacao: t(i.tendencia) })),
  };
}

/** Cidades: taxa de uso observada e a variação contra os 30 dias anteriores. */
export function adaptarCidades(d: Obj): Obj {
  if (!d?.disponivel) return d;
  return {
    ultimoDiaExtrato: d.ultimoDiaExtrato,
    extratoEmDia: d.extratoEmDia,
    diasDefasagem: d.diasDefasagem,
    medianaTaxaUsoPct: d.mediana,
    criterio: "taxa de uso = clientes com limite que usaram o cartão nos 30 dias até o último dia do extrato, dividido pelos clientes com limite; variação contra os 30 dias anteriores",
    cidades: (d.cidades ?? []).map((c: Obj) => ({
      cidade: c.cidade,
      clientes: c.clientes,
      inativos: c.inativos,
      usaramNaJanela: c.usaramAtual,
      usaramNaJanelaAnterior: c.usaramAnterior,
      taxaUsoPct: c.taxaUso,
      taxaUsoAnteriorPct: c.taxaUsoAnterior,
      variacaoPp: c.variacaoPp,
      classificacao: c.situacao,
      diasParaAbrirCiclo: c.abreEmDias,
    })),
  };
}

/** Convênios: uso e lucro observados. */
export function adaptarConvenios(d: Obj): Obj {
  return {
    disponivel: d.disponivel,
    ultimoDiaExtrato: d.ultimoDiaExtrato,
    extratoEmDia: d.extratoEmDia,
    diasDefasagem: d.diasDefasagem,
    clientesSemConvenio: d.semConvenio,
    medianaTaxaUsoPct: d.mediana,
    convenios: (d.convenios ?? []).map((c: Obj) => ({
      convenio: c.convenio,
      clientes: c.clientes,
      inativos: c.inativos,
      taxaUsoPct: c.taxaUso,
      variacaoPp: c.variacaoPp,
      classificacao: c.situacao,
      lucroAtual: c.lucroAtual,
      lucroAnterior: c.lucroAnterior,
      lucroVariacaoPct: c.lucroVariacaoPct,
    })),
    criterio: "janela de 30 dias até o último dia do extrato contra os 30 dias anteriores; lucro = juros das antecipações",
  };
}

/** Financeiro: acumulado do mês e comparação com o mês anterior até o mesmo dia. Sem projeção do fechamento. */
export function adaptarFinanceiro(d: Obj): Obj {
  if (!d?.disponivel) return d;
  const { projecao: _p, ...resto } = d;
  void _p;
  return { ...resto, criterio: "mês do último dia do extrato, acumulado até esse dia, contra o mês anterior até o mesmo dia; lucro = juros das antecipações" };
}

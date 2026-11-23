/**
 * Insights "o que melhorou / o que caiu": compara a foto de hoje com a de uma data anterior e
 * devolve o que mudou de forma relevante, já com leitura e ação sugerida. Cálculo puro (sem banco),
 * testado em insights.test.ts.
 *
 * Regras que evitam ruído e conclusão sem base:
 *  - amostra mínima: base muito pequena não gera insight;
 *  - variação mínima por métrica: oscilação pequena não é notícia;
 *  - taxas são comparadas em pontos percentuais sobre o total (a base cresce e muda, a contagem
 *    bruta enganaria);
 *  - métrica sem os dois lados (ex.: nota sem histórico comparável) é simplesmente omitida.
 */

export type Unidade = "pp" | "pts";
export type Confianca = "alta" | "media" | "baixa";

/** Foto resumida de um dia (vem de DashboardSnapshot, ou dos KPIs de agora). */
export interface FotoInsight {
  totalClientes: number;
  ativos: number;
  inativos: number;
  semUso: number;
  /** Clientes sem limite cadastrado (faixa INDEFINIDO). */
  indefinidos: number;
  /** valorUtilizado ÷ limiteTotal em %, ou null sem limite. */
  usoLimitePct: number | null;
  /** Nota de saúde comparável (mesmo modelo nos dois lados) ou null. */
  score: number | null;
}

export interface InsightVariacao {
  key: string;
  titulo: string;
  atual: number;
  anterior: number;
  /** Variação absoluta na unidade da métrica (pp para taxas, pts para a nota). */
  abs: number;
  unidade: Unidade;
  leitura: string;
  acao: { label: string; destino: string } | null;
  /** 1 (baixa) a 5 (alta): quanto a mudança pesa. */
  prioridade: number;
  confianca: Confianca;
}

export interface ResultadoInsights {
  melhorou: InsightVariacao[];
  caiu: InsightVariacao[];
  /** Quantas métricas avaliadas ficaram abaixo do limite de relevância. */
  estaveis: number;
  /** Preenchido quando nada pôde ser avaliado (o porquê, para a tela explicar). */
  indisponivel: "AMOSTRA_PEQUENA" | null;
}

export const AMOSTRA_MINIMA = 30;
const MAX_POR_LADO = 5;

interface Def {
  key: string;
  titulo: string;
  unidade: Unidade;
  /** true = subir é bom. */
  altoEhBom: boolean;
  /** Variação mínima (na unidade) para contar como mudança. */
  minimo: number;
  valor: (f: FotoInsight) => number | null;
  leitura: (d: { abs: number; bom: boolean; atual: number; anterior: number }) => string;
  acao: (bom: boolean) => { label: string; destino: string } | null;
}

const share = (n: number, total: number) => (total > 0 ? (n / total) * 100 : null);
const round1 = (n: number) => Math.round(n * 10) / 10;
const pctTxt = (n: number) => `${round1(n).toString().replace(".", ",")}%`;

const DEFS: Def[] = [
  {
    key: "ativosPct",
    titulo: "Clientes ativos",
    unidade: "pp",
    altoEhBom: true,
    minimo: 1,
    valor: (f) => share(f.ativos, f.totalClientes),
    leitura: ({ bom, atual, anterior }) =>
      bom
        ? `A fatia de ativos passou de ${pctTxt(anterior)} para ${pctTxt(atual)} da base.`
        : `A fatia de ativos caiu de ${pctTxt(anterior)} para ${pctTxt(atual)} da base.`,
    acao: (bom) => (bom ? null : { label: "Ver clientes inativos", destino: "/clients?statusConta=INATIVO" }),
  },
  {
    key: "inativosPct",
    titulo: "Clientes inativos",
    unidade: "pp",
    altoEhBom: false,
    minimo: 1,
    valor: (f) => share(f.inativos, f.totalClientes),
    leitura: ({ bom, atual, anterior }) =>
      bom
        ? `Os inativos recuaram de ${pctTxt(anterior)} para ${pctTxt(atual)} da base.`
        : `Os inativos subiram de ${pctTxt(anterior)} para ${pctTxt(atual)} da base. Reativar é a maior alavanca de crescimento.`,
    acao: (bom) => (bom ? null : { label: "Criar campanha de reativação", destino: "/campaigns/new" }),
  },
  {
    key: "semUsoPct",
    titulo: "Nunca usaram o cartão",
    unidade: "pp",
    altoEhBom: false,
    minimo: 1,
    valor: (f) => share(f.semUso, f.totalClientes),
    leitura: ({ bom, atual, anterior }) =>
      bom
        ? `Quem nunca usou caiu de ${pctTxt(anterior)} para ${pctTxt(atual)}: a ativação está funcionando.`
        : `Quem nunca usou subiu de ${pctTxt(anterior)} para ${pctTxt(atual)}: entram clientes novos sem ativação.`,
    acao: (bom) => (bom ? null : { label: "Criar campanha de ativação", destino: "/campaigns/new" }),
  },
  {
    key: "semLimitePct",
    titulo: "Clientes sem limite cadastrado",
    unidade: "pp",
    altoEhBom: false,
    minimo: 2,
    valor: (f) => share(f.indefinidos, f.totalClientes),
    leitura: ({ bom, atual, anterior }) =>
      bom
        ? `Clientes sem limite caíram de ${pctTxt(anterior)} para ${pctTxt(atual)}.`
        : `Clientes sem limite subiram de ${pctTxt(anterior)} para ${pctTxt(atual)}. Uma importação pode ter perdido a coluna de limite: confira o histórico.`,
    acao: (bom) => (bom ? null : { label: "Ver importações", destino: "/imports" }),
  },
  {
    key: "usoLimitePct",
    titulo: "Uso do limite",
    unidade: "pp",
    altoEhBom: true,
    // Oscila com o ciclo da folha (a fatura é descontada e o limite renova): exige mais para virar notícia.
    minimo: 3,
    valor: (f) => f.usoLimitePct,
    leitura: ({ bom, atual, anterior }) =>
      `${bom ? "Subiu" : "Caiu"} de ${pctTxt(anterior)} para ${pctTxt(atual)} do limite liberado. Esta métrica oscila com o ciclo da folha: compare períodos de mesma fase do ciclo.`,
    acao: () => null,
  },
  {
    key: "score",
    titulo: "Nota de saúde",
    unidade: "pts",
    altoEhBom: true,
    minimo: 2,
    valor: (f) => f.score,
    leitura: ({ bom, atual, anterior }) =>
      `A nota ${bom ? "subiu" : "caiu"} de ${Math.round(anterior)} para ${Math.round(atual)}.`,
    acao: () => null,
  },
];

export function confiancaDe(dias: number, totalClientes: number): Confianca {
  if (dias >= 14 && totalClientes >= 200) return "alta";
  if (dias >= 7 && totalClientes >= AMOSTRA_MINIMA) return "media";
  return "baixa";
}

/** Prioridade 1–5: quantas vezes a mudança passou do mínimo (2× = 3, 3× = 4, 4×+ = 5). */
export function prioridadeDe(abs: number, minimo: number): number {
  const vezes = Math.abs(abs) / minimo;
  return Math.max(1, Math.min(5, Math.round(1 + vezes)));
}

/**
 * Compara `atual` com `anterior` (`dias` = distância entre as fotos, só para a confiança).
 * Devolve até 5 itens de cada lado, os mais relevantes primeiro.
 */
export function buildMelhorouCaiu(atual: FotoInsight, anterior: FotoInsight, dias: number): ResultadoInsights {
  if (atual.totalClientes < AMOSTRA_MINIMA || anterior.totalClientes < AMOSTRA_MINIMA) {
    return { melhorou: [], caiu: [], estaveis: 0, indisponivel: "AMOSTRA_PEQUENA" };
  }
  const confianca = confiancaDe(dias, atual.totalClientes);
  const melhorou: InsightVariacao[] = [];
  const caiu: InsightVariacao[] = [];
  let estaveis = 0;

  for (const def of DEFS) {
    const a = def.valor(atual);
    const b = def.valor(anterior);
    if (a === null || b === null) continue; // sem os dois lados não há comparação honesta
    const abs = a - b;
    if (Math.abs(abs) < def.minimo) {
      estaveis++;
      continue;
    }
    const bom = def.altoEhBom ? abs > 0 : abs < 0;
    const item: InsightVariacao = {
      key: def.key,
      titulo: def.titulo,
      atual: round1(a),
      anterior: round1(b),
      abs: round1(abs),
      unidade: def.unidade,
      leitura: def.leitura({ abs, bom, atual: a, anterior: b }),
      acao: def.acao(bom),
      prioridade: prioridadeDe(abs, def.minimo),
      confianca,
    };
    (bom ? melhorou : caiu).push(item);
  }

  const ordena = (x: InsightVariacao, y: InsightVariacao) => y.prioridade - x.prioridade || Math.abs(y.abs) - Math.abs(x.abs);
  melhorou.sort(ordena);
  caiu.sort(ordena);
  return { melhorou: melhorou.slice(0, MAX_POR_LADO), caiu: caiu.slice(0, MAX_POR_LADO), estaveis, indisponivel: null };
}

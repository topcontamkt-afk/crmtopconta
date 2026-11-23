/**
 * Desempenho por cidade: quem se destaca e quem precisa de atenção. Cálculo puro (testado em
 * cidadeDesempenho.test.ts); a rota só monta as entradas a partir do extrato.
 *
 * Métrica: taxa de uso = clientes distintos que usaram (antecipação ou compra à vista) na janela ÷
 * clientes com limite da cidade, comparada com a janela anterior de mesmo tamanho. As janelas
 * terminam no último dia do extrato, não em hoje: com o extrato parado, "hoje" faria todas as
 * cidades parecerem em queda.
 *
 * Regras que evitam conclusão sem base: cidade pequena ou com poucos usos fica como "poucos dados"
 * e fora dos destaques; destaque e atenção também olham o nível contra a mediana das cidades.
 */

export type Situacao = "destaque" | "estavel" | "observar" | "atencao" | "poucos_dados";

export interface CidadeEntrada {
  cidadeKey: string;
  cidade: string;
  /** Clientes com limite (a base que pode usar). */
  clientes: number;
  inativos: number;
  usaramAtual: number;
  usaramAnterior: number;
  usosAtual: number;
  usosAnterior: number;
  /** Dias até o ciclo da cidade abrir (null = sem ciclo cadastrado). */
  abreEmDias: number | null;
}

export interface CidadeDesempenho extends CidadeEntrada {
  /** % dos clientes com limite que usaram na janela atual (null = poucos dados). */
  taxaUso: number | null;
  taxaUsoAnterior: number | null;
  /** Variação da taxa em pontos percentuais (null = poucos dados). */
  variacaoPp: number | null;
  situacao: Situacao;
  motivo: string;
  /** Estimativa de clientes em jogo (queda ou distância da mediana), para ordenar a atenção. */
  clientesEmJogo: number;
}

export interface ResultadoCidades {
  cidades: CidadeDesempenho[];
  emDestaque: CidadeDesempenho | null;
  precisaAtencao: CidadeDesempenho | null;
  /** Mediana da taxa de uso entre as cidades com dados suficientes. */
  mediana: number | null;
}

export const MIN_CLIENTES_CIDADE = 30;
export const MIN_USOS_CIDADE = 30;
const QUEDA_ATENCAO_PP = -5;
const QUEDA_OBSERVAR_PP = -2;
const ALTA_DESTAQUE_PP = 3;
const ATENCAO_FRACAO_MEDIANA = 0.5;

const round1 = (n: number) => Math.round(n * 10) / 10;
const fmt = (n: number) => round1(n).toString().replace(".", ",");

function mediana(valores: number[]): number | null {
  if (valores.length === 0) return null;
  const v = [...valores].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export function avaliarCidades(entradas: CidadeEntrada[]): ResultadoCidades {
  const base = entradas.map((e) => {
    const poucos = e.clientes < MIN_CLIENTES_CIDADE || e.usosAtual + e.usosAnterior < MIN_USOS_CIDADE;
    const taxaUso = poucos ? null : (e.usaramAtual / e.clientes) * 100;
    const taxaUsoAnterior = poucos ? null : (e.usaramAnterior / e.clientes) * 100;
    const variacaoPp = taxaUso !== null && taxaUsoAnterior !== null ? taxaUso - taxaUsoAnterior : null;
    return { e, poucos, taxaUso, taxaUsoAnterior, variacaoPp };
  });
  const med = mediana(base.filter((b) => b.taxaUso !== null).map((b) => b.taxaUso as number));

  const cidades: CidadeDesempenho[] = base.map(({ e, poucos, taxaUso, taxaUsoAnterior, variacaoPp }) => {
    let situacao: Situacao = "estavel";
    let motivo = "";
    let clientesEmJogo = 0;
    if (poucos || taxaUso === null || variacaoPp === null) {
      situacao = "poucos_dados";
      motivo = e.clientes < MIN_CLIENTES_CIDADE ? `Menos de ${MIN_CLIENTES_CIDADE} clientes com limite.` : `Menos de ${MIN_USOS_CIDADE} usos no período.`;
    } else {
      const muitoAbaixo = med !== null && med > 0 && taxaUso < med * ATENCAO_FRACAO_MEDIANA;
      if (variacaoPp <= QUEDA_ATENCAO_PP || muitoAbaixo) {
        situacao = "atencao";
        motivo =
          variacaoPp <= QUEDA_ATENCAO_PP
            ? `Uso caiu ${fmt(Math.abs(variacaoPp))} p.p. (${fmt(taxaUsoAnterior as number)}% → ${fmt(taxaUso)}%).`
            : `Uso de ${fmt(taxaUso)}%, menos da metade da mediana das cidades (${fmt(med as number)}%).`;
        clientesEmJogo = Math.round((e.clientes * (variacaoPp < 0 ? -variacaoPp : (med as number) - taxaUso)) / 100);
      } else if (variacaoPp <= QUEDA_OBSERVAR_PP) {
        situacao = "observar";
        motivo = `Uso caiu ${fmt(Math.abs(variacaoPp))} p.p.: acompanhar.`;
        clientesEmJogo = Math.round((e.clientes * -variacaoPp) / 100);
      } else if (variacaoPp >= ALTA_DESTAQUE_PP && med !== null && taxaUso >= med) {
        situacao = "destaque";
        motivo = `Uso subiu ${fmt(variacaoPp)} p.p. (${fmt(taxaUsoAnterior as number)}% → ${fmt(taxaUso)}%), acima da mediana.`;
      } else {
        motivo = "Sem mudança relevante.";
      }
    }
    return {
      ...e,
      taxaUso: taxaUso === null ? null : round1(taxaUso),
      taxaUsoAnterior: taxaUsoAnterior === null ? null : round1(taxaUsoAnterior),
      variacaoPp: variacaoPp === null ? null : round1(variacaoPp),
      situacao,
      motivo,
      clientesEmJogo,
    };
  });

  const ordem: Record<Situacao, number> = { atencao: 0, observar: 1, estavel: 2, destaque: 3, poucos_dados: 4 };
  cidades.sort((a, b) => ordem[a.situacao] - ordem[b.situacao] || b.clientesEmJogo - a.clientesEmJogo || b.clientes - a.clientes);

  const emDestaque =
    cidades.filter((c) => c.situacao === "destaque").sort((a, b) => (b.variacaoPp ?? 0) - (a.variacaoPp ?? 0) || b.clientes - a.clientes)[0] ?? null;
  const precisaAtencao = cidades.filter((c) => c.situacao === "atencao").sort((a, b) => b.clientesEmJogo - a.clientesEmJogo)[0] ?? null;
  return { cidades, emDestaque, precisaAtencao, mediana: med === null ? null : round1(med) };
}

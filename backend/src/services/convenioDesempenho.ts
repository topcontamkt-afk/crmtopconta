/**
 * Desempenho por convênio (empresa conveniada). Reaproveita a classificação das cidades
 * (cidadeDesempenho.ts): mesma taxa de uso, mesmas janelas (30 dias contra os 30 anteriores,
 * terminando no último dia do extrato), mesmos mínimos de amostra e a mesma mediana. Soma o lucro
 * (juros das antecipações) e uma estimativa conservadora do que a reativação renderia.
 *
 * Lucro = só `Purchase.juros` de antecipação: o lucro da compra à vista (taxa do lojista) é
 * desconhecido e fica de fora em vez de contar como zero.
 */
import { avaliarCidades, CidadeDesempenho } from "./cidadeDesempenho";

export interface ConvenioEntrada {
  chave: string;
  convenio: string;
  clientes: number;
  inativos: number;
  usaramAtual: number;
  usaramAnterior: number;
  usosAtual: number;
  usosAnterior: number;
  lucroAtual: number;
  lucroAnterior: number;
}

export interface ConvenioDesempenho extends Omit<CidadeDesempenho, "cidadeKey" | "cidade" | "abreEmDias"> {
  chave: string;
  convenio: string;
  lucroAtual: number;
  lucroAnterior: number;
  /** Variação % do lucro (null sem base anterior). */
  lucroVariacaoPct: number | null;
  /** Lucro mensal estimado se 10% dos inativos passassem a render como quem usou (null sem base para estimar). */
  potencial10pct: number | null;
}

export interface ResultadoConvenios {
  convenios: ConvenioDesempenho[];
  emDestaque: ConvenioDesempenho | null;
  precisaAtencao: ConvenioDesempenho | null;
  mediana: number | null;
}

/** Quantos clientes que usaram são necessários para estimar o lucro por cliente. */
export const MIN_USUARIOS_PARA_POTENCIAL = 10;
const FRACAO_REATIVADA = 0.1;
const round2 = (n: number) => Math.round(n * 100) / 100;

export function avaliarConvenios(entradas: ConvenioEntrada[]): ResultadoConvenios {
  const base = avaliarCidades(
    entradas.map((e) => ({
      cidadeKey: e.chave,
      cidade: e.convenio,
      clientes: e.clientes,
      inativos: e.inativos,
      usaramAtual: e.usaramAtual,
      usaramAnterior: e.usaramAnterior,
      usosAtual: e.usosAtual,
      usosAnterior: e.usosAnterior,
      abreEmDias: null,
    }))
  );
  const porChave = new Map(entradas.map((e) => [e.chave, e]));
  const converte = (c: CidadeDesempenho): ConvenioDesempenho => {
    const e = porChave.get(c.cidadeKey)!;
    const { cidadeKey, cidade, abreEmDias, ...resto } = c;
    void abreEmDias;
    const podeEstimar = e.usaramAtual >= MIN_USUARIOS_PARA_POTENCIAL && e.lucroAtual > 0;
    return {
      ...resto,
      chave: cidadeKey,
      convenio: cidade,
      lucroAtual: round2(e.lucroAtual),
      lucroAnterior: round2(e.lucroAnterior),
      lucroVariacaoPct: e.lucroAnterior > 0 ? Math.round(((e.lucroAtual - e.lucroAnterior) / e.lucroAnterior) * 1000) / 10 : null,
      potencial10pct: podeEstimar ? Math.round(FRACAO_REATIVADA * e.inativos * (e.lucroAtual / e.usaramAtual)) : null,
    };
  };
  return {
    convenios: base.cidades.map(converte),
    emDestaque: base.emDestaque ? converte(base.emDestaque) : null,
    precisaAtencao: base.precisaAtencao ? converte(base.precisaAtencao) : null,
    mediana: base.mediana,
  };
}

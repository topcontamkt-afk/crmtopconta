/**
 * Financeiro e metas: períodos do mês, projeção do fechamento e progresso contra a meta. Cálculo
 * puro (testado em financeiro.test.ts); a rota monta os números a partir do extrato.
 *
 * O "mês" é o do ÚLTIMO DIA DO EXTRATO (não o de hoje): com o extrato parado, comparar "até hoje"
 * faria o mês atual parecer vazio. O mês anterior é cortado no mesmo dia do mês, para comparar
 * período igual com período igual.
 *
 * Lucro = só os juros das antecipações. O lucro da compra à vista (taxa do lojista) é desconhecido e
 * fica de fora em vez de contar como zero.
 */

export interface PeriodoMes {
  /** "2026-10". */
  mes: string;
  rotulo: string;
  diaAtual: number;
  diasNoMes: number;
  atual: { de: string; ate: string };
  /** Mês anterior, de 1 até o mesmo dia do mês (limitado ao tamanho dele). */
  anterior: { de: string; ate: string };
}

const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const pad = (n: number) => String(n).padStart(2, "0");
const diasNoMesDe = (ano: number, mes: number) => new Date(Date.UTC(ano, mes, 0)).getUTCDate();

/** Períodos de comparação a partir do último dia do extrato ("YYYY-MM-DD"); null se a data for inválida. */
export function periodoDoMes(ultimoDia: string): PeriodoMes | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ultimoDia);
  if (!m) return null;
  const ano = Number(m[1]);
  const mes = Number(m[2]);
  const dia = Number(m[3]);
  if (mes < 1 || mes > 12 || dia < 1 || dia > diasNoMesDe(ano, mes)) return null;
  const mesAnt = mes === 1 ? 12 : mes - 1;
  const anoAnt = mes === 1 ? ano - 1 : ano;
  const diaAnt = Math.min(dia, diasNoMesDe(anoAnt, mesAnt));
  return {
    mes: `${ano}-${pad(mes)}`,
    rotulo: `${MESES[mes - 1]} de ${ano}`,
    diaAtual: dia,
    diasNoMes: diasNoMesDe(ano, mes),
    atual: { de: `${ano}-${pad(mes)}-01`, ate: ultimoDia },
    anterior: { de: `${anoAnt}-${pad(mesAnt)}-01`, ate: `${anoAnt}-${pad(mesAnt)}-${pad(diaAnt)}` },
  };
}

/** Semana do mês (1: dias 1–7, 2: 8–14, 3: 15–21, 4: 22 em diante). */
export function semanaDoMes(dia: number): 1 | 2 | 3 | 4 {
  return Math.min(4, Math.floor((dia - 1) / 7) + 1) as 1 | 2 | 3 | 4;
}

/** Variação % contra a base anterior (null sem base, para não mostrar +∞%). */
export function variacaoPct(atual: number, anterior: number): number | null {
  if (!(anterior > 0)) return null;
  return Math.round(((atual - anterior) / anterior) * 1000) / 10;
}

export type Confianca = "alta" | "media" | "baixa";

export interface Projecao {
  valor: number;
  confianca: Confianca;
}

/**
 * Projeção linear do fechamento: acumulado ÷ dias passados × dias do mês. Ignora que o uso se
 * concentra na abertura do ciclo de cada cidade, por isso a confiança cai com poucos dias de mês e
 * com o extrato parado (o ritmo "atual" já é antigo).
 */
export function projetarMes(acumulado: number, diaAtual: number, diasNoMes: number, extratoEmDia: boolean): Projecao {
  if (diaAtual >= diasNoMes) return { valor: Math.round(acumulado * 100) / 100, confianca: extratoEmDia ? "alta" : "media" };
  const bruto = diaAtual > 0 ? (acumulado / diaAtual) * diasNoMes : acumulado;
  let nivel = diaAtual < 7 ? 0 : diaAtual < 15 ? 1 : 2; // 0 baixa, 1 média, 2 alta
  if (!extratoEmDia) nivel = Math.max(0, nivel - 1);
  return { valor: Math.round(bruto * 100) / 100, confianca: (["baixa", "media", "alta"] as const)[nivel] };
}

export interface Metas {
  lucro: number | null;
  usos: number | null;
}

export interface Progresso {
  pct: number;
  atingida: boolean;
}

/** Quanto da meta já foi feito; null sem meta (ou meta zero). */
export function progressoMeta(valor: number, meta: number | null | undefined): Progresso | null {
  if (!meta || !(meta > 0)) return null;
  const pct = Math.round((valor / meta) * 1000) / 10;
  return { pct, atingida: valor >= meta };
}

/** Lê as metas guardadas (JSON livre no banco) com tolerância: valores inválidos viram null. */
export function lerMetas(raw: unknown): Metas {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  return { lucro: num(r.lucro), usos: num(r.usos) };
}

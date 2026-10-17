/**
 * Período do filtro por datas do dashboard ("uso no período"): datas civis de Brasília (YYYY-MM-DD). Puro, sem banco.
 * Sem datas, vale a janela de N dias terminando hoje. Só `de` => até hoje; só `ate` => N dias antes dele.
 */
export interface PeriodoUso {
  de: string;
  ate: string;
  dias: number; // quantidade de dias do período (inclusive)
}

export const MAX_DIAS_PERIODO = 366;

const ms = (iso: string) => Date.parse(`${iso}T00:00:00.000Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const DIA = 86_400_000;

export function validaData(s: string | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(ms(s)) && iso(ms(s)) === s;
}

export function resolvePeriodo(input: { de?: string; ate?: string; days?: number }, hoje: string): PeriodoUso | { erro: string } {
  const n = input.days && input.days > 0 ? input.days : 30;
  if (input.de !== undefined && !validaData(input.de)) return { erro: "Data inicial inválida" };
  if (input.ate !== undefined && !validaData(input.ate)) return { erro: "Data final inválida" };
  const ate = input.ate ?? hoje;
  const de = input.de ?? iso(ms(ate) - (n - 1) * DIA);
  if (ms(de) > ms(ate)) return { erro: "A data inicial é depois da final" };
  const dias = Math.round((ms(ate) - ms(de)) / DIA) + 1;
  if (dias > MAX_DIAS_PERIODO) return { erro: `Período máximo de ${MAX_DIAS_PERIODO} dias` };
  return { de, ate, dias };
}

/** Período de mesma duração imediatamente anterior (para a comparação). */
export function periodoAnterior(p: PeriodoUso): PeriodoUso {
  const ate = iso(ms(p.de) - DIA);
  const de = iso(ms(ate) - (p.dias - 1) * DIA);
  return { de, ate, dias: p.dias };
}

/** Preenche com zero os dias sem uso, para o gráfico mostrar a sequência inteira. */
export function preencheDias<T extends { dia: string }>(p: PeriodoUso, rows: T[], vazio: (dia: string) => T): T[] {
  const por = new Map(rows.map((r) => [r.dia, r]));
  const out: T[] = [];
  for (let t = ms(p.de); t <= ms(p.ate); t += DIA) {
    const d = iso(t);
    out.push(por.get(d) ?? vazio(d));
  }
  return out;
}

/** Variação percentual contra o período anterior; null quando não há base. */
export function variacaoPct(atual: number, anterior: number): number | null {
  if (!anterior) return null;
  return Math.round(((atual - anterior) / anterior) * 1000) / 10;
}

// ---------- Taxa de recorrência ----------

/**
 * Recorrência = dos clientes que usaram no período (antecipação ou compra à vista), quantos usaram 2 vezes ou mais.
 * Meta de saúde definida pela TopConta: 80% ou mais é saudável.
 */
export const META_RECORRENCIA = 80;
export const LIMITE_ATENCAO_RECORRENCIA = 60;

export type FaixaRecorrencia = "SAUDAVEL" | "ATENCAO" | "BAIXA";

/** Percentual com 1 casa (0-100); null quando ninguém usou no período. */
export function taxaRecorrencia(recorrentes: number, usaram: number): number | null {
  if (!usaram || usaram <= 0) return null;
  return Math.round((recorrentes / usaram) * 1000) / 10;
}

export function faixaRecorrencia(taxa: number | null): FaixaRecorrencia | null {
  if (taxa === null) return null;
  if (taxa >= META_RECORRENCIA) return "SAUDAVEL";
  if (taxa >= LIMITE_ATENCAO_RECORRENCIA) return "ATENCAO";
  return "BAIXA";
}

/** Diferença em pontos percentuais (atual - anterior); null se falta um dos lados. */
export function variacaoPontos(atual: number | null, anterior: number | null): number | null {
  if (atual === null || anterior === null) return null;
  return Math.round((atual - anterior) * 10) / 10;
}

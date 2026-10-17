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

// ---------- Adesão: % da base ativa que usou o saldo ----------

/**
 * Meta da TopConta: pelo menos 80% da base ATIVA (conta ativa e com limite) deve usar o saldo. Adesão = clientes ativos
 * com limite que usaram no período (antecipação ou compra à vista) ÷ clientes ativos com limite. Por cidade e no geral.
 */
export const META_ADESAO = 80;
export const LIMITE_ATENCAO_ADESAO = 60;

export type FaixaAdesao = "SAUDAVEL" | "ATENCAO" | "BAIXA";

/** Percentual com 1 casa (0-100); null quando não há base. */
export function taxaAdesao(usaram: number, base: number): number | null {
  if (!base || base <= 0) return null;
  return Math.round((usaram / base) * 1000) / 10;
}

export function faixaAdesao(taxa: number | null): FaixaAdesao | null {
  if (taxa === null) return null;
  if (taxa >= META_ADESAO) return "SAUDAVEL";
  if (taxa >= LIMITE_ATENCAO_ADESAO) return "ATENCAO";
  return "BAIXA";
}

/** Quantos clientes a mais precisam usar para a base chegar na meta (0 se já chegou). */
export function faltamParaMeta(usaram: number, base: number, meta: number = META_ADESAO): number {
  if (!base || base <= 0) return 0;
  return Math.max(0, Math.ceil((base * meta) / 100) - usaram);
}

/** Diferença em pontos percentuais (atual - anterior); null se falta um dos lados. */
export function variacaoPontos(atual: number | null, anterior: number | null): number | null {
  if (atual === null || anterior === null) return null;
  return Math.round((atual - anterior) * 10) / 10;
}

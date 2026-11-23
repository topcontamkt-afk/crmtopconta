/**
 * Melhor horário de disparo, a partir de quando os clientes de fato usam o cartão. Cálculo puro
 * (testado em horarioUso.test.ts); a rota só monta as linhas a partir do extrato.
 *
 * Duas fontes, que não se misturam:
 *  - horário de PICO de uso por segmento: vem do extrato (hora de Brasília de cada antecipação/compra);
 *  - ANTECEDÊNCIA (quantos minutos antes do pico enviar): vem do tempo medido entre o envio de uma
 *    mensagem e o primeiro uso do cliente. Sem amostra suficiente cai num padrão e a tela diz que é
 *    estimativa, porque o que ainda não foi medido não pode virar "melhor horário" com ar de certeza.
 */

export const MIN_USOS_SEGMENTO = 30;
export const AMOSTRA_MIN_ANTECEDENCIA = 30;
export const ANTECEDENCIA_PADRAO_MIN = 30;
/** Janela comercial em que a sugestão de envio fica (7h às 21h): pico de madrugada não vira mensagem de madrugada. */
export const HORA_MIN_ENVIO = 7;
export const HORA_MAX_ENVIO = 21;

export interface LinhaHora {
  /** Hora do dia (0–23) no fuso de Brasília. */
  hora: number;
  segmento: string;
  usos: number;
}

export interface SegmentoHorario {
  key: string;
  label: string;
  clientes: number;
  usos: number;
  porHora: number[];
  /** Hora de maior uso (null = poucos dados). */
  picoHora: number | null;
  poucosDados: boolean;
}

export type Confianca = "alta" | "media" | "baixa";

export interface Antecedencia {
  fonte: "medida" | "padrao";
  /** Mediana em minutos. */
  medianaMin: number;
  p25Min: number | null;
  p75Min: number | null;
  amostra: number;
}

export interface Sugestao {
  /** "HH:MM" do envio sugerido. */
  horario: string;
  picoHora: number;
  antecedenciaMin: number;
  /** O pico caiu fora da janela comercial e a sugestão foi trazida para dentro dela. */
  ajustadoPelaJanela: boolean;
  confianca: Confianca;
}

const zeros = () => new Array<number>(24).fill(0);

/** Agrupa as linhas por segmento (e o total), ignorando horas inválidas. */
export function construirHorarios(
  linhas: LinhaHora[],
  segmentos: { key: string; label: string; clientes: number }[]
): { total: number[]; usosTotal: number; segmentos: SegmentoHorario[] } {
  const total = zeros();
  const porSeg = new Map<string, number[]>();
  for (const l of linhas) {
    if (!Number.isInteger(l.hora) || l.hora < 0 || l.hora > 23 || !(l.usos > 0)) continue;
    total[l.hora] += l.usos;
    if (!porSeg.has(l.segmento)) porSeg.set(l.segmento, zeros());
    porSeg.get(l.segmento)![l.hora] += l.usos;
  }
  const result: SegmentoHorario[] = segmentos.map((s) => {
    const porHora = porSeg.get(s.key) ?? zeros();
    const usos = porHora.reduce((a, b) => a + b, 0);
    const poucosDados = usos < MIN_USOS_SEGMENTO;
    return { ...s, usos, porHora, picoHora: poucosDados ? null : picoDe(porHora), poucosDados };
  });
  return { total, usosTotal: total.reduce((a, b) => a + b, 0), segmentos: result };
}

/** Hora de maior uso; em empate, a mais cedo. */
export function picoDe(porHora: number[]): number {
  let melhor = 0;
  for (let h = 1; h < porHora.length; h++) if (porHora[h] > porHora[melhor]) melhor = h;
  return melhor;
}

function percentil(ordenado: number[], p: number): number {
  if (ordenado.length === 1) return ordenado[0];
  const idx = (ordenado.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return ordenado[lo] + (ordenado[hi] - ordenado[lo]) * (idx - lo);
}

/**
 * Antecedência a partir dos atrasos medidos (minutos entre o envio e o primeiro uso). Com amostra
 * menor que o mínimo usa o padrão. Atrasos fora de 0–24h são descartados.
 */
export function estimarAntecedencia(atrasosMin: number[]): Antecedencia {
  const validos = atrasosMin.filter((m) => Number.isFinite(m) && m >= 0 && m <= 24 * 60).sort((a, b) => a - b);
  if (validos.length < AMOSTRA_MIN_ANTECEDENCIA) {
    return { fonte: "padrao", medianaMin: ANTECEDENCIA_PADRAO_MIN, p25Min: null, p75Min: null, amostra: validos.length };
  }
  const r = (n: number) => Math.round(n);
  return {
    fonte: "medida",
    medianaMin: r(percentil(validos, 0.5)),
    p25Min: r(percentil(validos, 0.25)),
    p75Min: r(percentil(validos, 0.75)),
    amostra: validos.length,
  };
}

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** Envio sugerido = início da hora de pico − antecedência, arredondado a 5 min e mantido na janela comercial. */
export function sugerirHorario(picoHora: number, antecedencia: Antecedencia, usosSegmento: number): Sugestao {
  const alvo = picoHora * 60 - antecedencia.medianaMin;
  const arredondado = Math.round(alvo / 5) * 5;
  const minimo = HORA_MIN_ENVIO * 60;
  const maximo = HORA_MAX_ENVIO * 60;
  const ajustado = Math.min(maximo, Math.max(minimo, arredondado));
  const confianca: Confianca =
    antecedencia.fonte === "padrao" ? "baixa" : usosSegmento >= 200 ? "alta" : usosSegmento >= 100 ? "media" : "baixa";
  return {
    horario: hhmm(ajustado),
    picoHora,
    antecedenciaMin: antecedencia.medianaMin,
    ajustadoPelaJanela: ajustado !== arredondado,
    confianca,
  };
}

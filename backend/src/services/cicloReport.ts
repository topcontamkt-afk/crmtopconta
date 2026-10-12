import { cicloInfo, DiaCivil, hojeBrasilia } from "./ciclos";
import { EventEvaluation, liftAtDay, statsAtDay } from "./campaignResults";

/**
 * Relatórios por dia do ciclo (fase 3): (1) em que dia do ciclo as pessoas usam o cartão, medido pelo extrato, com
 * diagnóstico da data de abertura cadastrada; (2) resultado da campanha quebrado pelo dia do ciclo em que o cliente
 * recebeu a mensagem. Cálculo puro (sem banco), em dias civis de Brasília.
 */

export const parseDia = (s: string): DiaCivil => {
  const [y, m, d] = s.split("-").map(Number);
  return { y, m, d };
};
const utcMs = (c: DiaCivil) => Date.UTC(c.y, c.m - 1, c.d);
const addDias = (c: DiaCivil, n: number): DiaCivil => {
  const t = new Date(utcMs(c) + n * 86400000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const iso = (c: DiaCivil) => `${c.y}-${String(c.m).padStart(2, "0")}-${String(c.d).padStart(2, "0")}`;

// ---------- 1) Uso por dia do ciclo ----------

export interface UsoRow {
  cidadeKey: string;
  /** dia da semana não importa: data civil (YYYY-MM-DD, Brasília) do uso */
  data: string;
  usos: number;
  antecipacoes: number;
}

export interface CidadeCiclo {
  cidadeKey: string;
  cidade: string;
  diaAbertura: number;
  /** clientes com limite nessa cidade (denominador) */
  clientes: number;
}

export interface PontoCurva {
  diaDoCiclo: number;
  usos: number;
  antecipacoes: number;
  /** dias do período observados com esse dia do ciclo (nas cidades somadas) */
  diasObservados: number;
  /** usos por 100 clientes por dia observado; null se não houve dia observado */
  usosPor100: number | null;
}

export type DiagnosticoCiclo = "OK" | "REVISAR" | "POUCOS_DADOS";

export interface CurvaCiclo {
  cidadeKey: string | null; // null = todas as cidades
  cidade: string;
  diaAbertura: number | null;
  clientes: number;
  usos: number;
  curva: PontoCurva[];
  picoDiaDoCiclo: number | null;
  diagnostico: DiagnosticoCiclo;
  mensagem: string;
}

export const MIN_USOS_DIAGNOSTICO = 30;
/** O pico de uso deve cair nos primeiros dias do ciclo (limite acabou de renovar). */
export const PICO_ESPERADO_ATE = 3;

function curvaDe(cidades: CidadeCiclo[], usoPorCidade: Map<string, UsoRow[]>, de: DiaCivil, ate: DiaCivil) {
  const usos = Array<number>(32).fill(0);
  const antecip = Array<number>(32).fill(0);
  const exposicao = Array<number>(32).fill(0); // dias observados por dia do ciclo
  const denominador = Array<number>(32).fill(0); // clientes × dias observados
  const totalDias = Math.round((utcMs(ate) - utcMs(de)) / 86400000) + 1;

  for (const c of cidades) {
    for (let i = 0; i < totalDias; i++) {
      const dc = cicloInfo(c.diaAbertura, addDias(de, i)).diaDoCiclo;
      if (dc >= 1 && dc <= 31) {
        exposicao[dc]++;
        denominador[dc] += c.clientes;
      }
    }
    for (const r of usoPorCidade.get(c.cidadeKey) ?? []) {
      const dc = cicloInfo(c.diaAbertura, parseDia(r.data)).diaDoCiclo;
      if (dc >= 1 && dc <= 31) {
        usos[dc] += r.usos;
        antecip[dc] += r.antecipacoes;
      }
    }
  }
  const curva: PontoCurva[] = [];
  for (let d = 1; d <= 31; d++) {
    curva.push({
      diaDoCiclo: d,
      usos: usos[d],
      antecipacoes: antecip[d],
      diasObservados: exposicao[d],
      usosPor100: denominador[d] > 0 ? Math.round((usos[d] / denominador[d]) * 10000) / 100 : null,
    });
  }
  return curva;
}

function diagnosticar(curva: PontoCurva[], totalUsos: number): { pico: number | null; diagnostico: DiagnosticoCiclo; mensagem: string } {
  if (totalUsos < MIN_USOS_DIAGNOSTICO) {
    return { pico: null, diagnostico: "POUCOS_DADOS", mensagem: "Poucos usos no período para avaliar o ciclo." };
  }
  let pico: PontoCurva | null = null;
  for (const p of curva) if (p.usosPor100 !== null && (pico === null || p.usosPor100 > (pico.usosPor100 ?? -1))) pico = p;
  if (!pico) return { pico: null, diagnostico: "POUCOS_DADOS", mensagem: "Sem dias observados no período." };
  if (pico.diaDoCiclo <= PICO_ESPERADO_ATE) {
    return { pico: pico.diaDoCiclo, diagnostico: "OK", mensagem: `O uso é maior no dia ${pico.diaDoCiclo} do ciclo, como esperado quando o limite renova na abertura.` };
  }
  return {
    pico: pico.diaDoCiclo,
    diagnostico: "REVISAR",
    mensagem: `O pico de uso está no dia ${pico.diaDoCiclo} do ciclo, não nos primeiros dias. Confira o dia de abertura cadastrado (ou se o limite renova mais tarde).`,
  };
}

/**
 * Curva de uso por dia do ciclo, por cidade e no total. O uso por dia é normalizado por clientes × dias observados
 * (o extrato cobre um período parcial, então cada dia do ciclo foi visto um número diferente de vezes).
 */
export function buildUsoPorDiaCiclo(input: { cidades: CidadeCiclo[]; uso: UsoRow[]; de: string; ate: string }): CurvaCiclo[] {
  const de = parseDia(input.de);
  const ate = parseDia(input.ate);
  const porCidade = new Map<string, UsoRow[]>();
  for (const r of input.uso) porCidade.set(r.cidadeKey, [...(porCidade.get(r.cidadeKey) ?? []), r]);

  const out: CurvaCiclo[] = input.cidades.map((c) => {
    const curva = curvaDe([c], porCidade, de, ate);
    const usos = curva.reduce((a, p) => a + p.usos, 0);
    const d = diagnosticar(curva, usos);
    return { cidadeKey: c.cidadeKey, cidade: c.cidade, diaAbertura: c.diaAbertura, clientes: c.clientes, usos, curva, picoDiaDoCiclo: d.pico, diagnostico: d.diagnostico, mensagem: d.mensagem };
  });

  const curvaTodas = curvaDe(input.cidades, porCidade, de, ate);
  const usosTodas = curvaTodas.reduce((a, p) => a + p.usos, 0);
  const dt = diagnosticar(curvaTodas, usosTodas);
  out.unshift({
    cidadeKey: null,
    cidade: "Todas as cidades",
    diaAbertura: null,
    clientes: input.cidades.reduce((a, c) => a + c.clientes, 0),
    usos: usosTodas,
    curva: curvaTodas,
    picoDiaDoCiclo: dt.pico,
    diagnostico: dt.diagnostico,
    mensagem: dt.mensagem,
  });
  return out;
}

/** Período a analisar: os últimos `dias` dias terminando no último dia do extrato (não em hoje: o extrato pode estar parado). */
export function periodoAnalise(primeiro: string | null, ultimo: string | null, dias: number): { de: string; ate: string } | null {
  if (!primeiro || !ultimo) return null;
  const ate = parseDia(ultimo);
  const de0 = addDias(ate, -(dias - 1));
  const p = parseDia(primeiro);
  const de = utcMs(de0) < utcMs(p) ? p : de0;
  return { de: iso(de), ate: iso(ate) };
}

// ---------- 2) Resultado da campanha por dia do ciclo no envio ----------

export type FaixaCiclo = "D1_3" | "D4_7" | "D8_15" | "D16_MAIS" | "SEM_CICLO";
export const FAIXAS_CICLO: FaixaCiclo[] = ["D1_3", "D4_7", "D8_15", "D16_MAIS", "SEM_CICLO"];
export const FAIXA_CICLO_LABEL: Record<FaixaCiclo, string> = {
  D1_3: "Dias 1 a 3 do ciclo",
  D4_7: "Dias 4 a 7",
  D8_15: "Dias 8 a 15",
  D16_MAIS: "Dia 16 em diante",
  SEM_CICLO: "Cidade sem ciclo",
};

export function faixaDoDiaCiclo(dia: number | null): FaixaCiclo {
  if (dia === null) return "SEM_CICLO";
  if (dia <= 3) return "D1_3";
  if (dia <= 7) return "D4_7";
  if (dia <= 15) return "D8_15";
  return "D16_MAIS";
}

/** Dia do ciclo em que o cliente estava no momento `ref` (Brasília), pela abertura da cidade dele. */
export function diaDoCicloNoEnvio(diaAbertura: number | null | undefined, ref: Date): number | null {
  if (!diaAbertura) return null;
  return cicloInfo(diaAbertura, hojeBrasilia(ref)).diaDoCiclo;
}

export interface CicloResultado {
  faixa: FaixaCiclo;
  label: string;
  enviados: number;
  convertidos: number;
  taxa: number;
  lucro: number;
  controle: number;
  taxaControle: number | null;
  liftPontos: number | null;
  significativo95: boolean | null;
}

export function breakdownByCiclo(
  treated: EventEvaluation[],
  control: EventEvaluation[],
  aberturaOf: (clientId: string) => number | null | undefined,
  dia: number
): CicloResultado[] {
  const of = (e: EventEvaluation) => faixaDoDiaCiclo(diaDoCicloNoEnvio(aberturaOf(e.clientId), e.ref));
  return FAIXAS_CICLO.map((faixa) => {
    const t = treated.filter((e) => of(e) === faixa);
    const c = control.filter((e) => of(e) === faixa);
    const st = statsAtDay(t, dia);
    const lift = c.length > 0 && t.length > 0 ? liftAtDay(t, c, dia) : null;
    return {
      faixa,
      label: FAIXA_CICLO_LABEL[faixa],
      enviados: st.n,
      convertidos: st.convertidos,
      taxa: st.taxa,
      lucro: st.lucro,
      controle: c.length,
      taxaControle: lift ? lift.taxaControle : null,
      liftPontos: lift && !lift.dadosInsuficientes ? lift.liftPontos : null,
      significativo95: lift ? lift.significativo95 : null,
    };
  }).filter((r) => r.enviados > 0 || r.controle > 0);
}

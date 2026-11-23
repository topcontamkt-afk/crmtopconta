/**
 * Risco de abandono por cliente: nota de 0 a 100 de quão provável é o cliente parar de usar o
 * cartão, e por quê. Cálculo puro (testado em riscoAbandono.test.ts).
 *
 * É uma ESTIMATIVA POR REGRAS, não um modelo estatístico treinado: soma cinco sinais com pesos
 * fixos e explica cada ponto. Só pontua quem já usou (não dá para abandonar o que nunca usou — para
 * esses vale a ativação) e tem limite. O "agora" é o último dia do extrato: com o extrato parado,
 * contar até hoje faria todo mundo parecer sumido.
 *
 *  - atraso (35):      dias sem uso comparados ao intervalo normal do cliente (90 dias ÷ usos);
 *  - queda (25):       usos nos últimos 30 dias contra a média dos 60 dias anteriores;
 *  - saldo parado (15): saldo alto sem uso, já estando atrasado;
 *  - ciclo (15):       o limite da cidade renovou e o cliente não usou;
 *  - campanhas (10):   recebeu mensagens e não respondeu.
 */

export type NivelRisco = "alto" | "medio" | "baixo";
export type ConfiancaRisco = "alta" | "media" | "baixa";

export const NIVEL_ALTO = 60;
export const NIVEL_MEDIO = 35;
const PESOS = { atraso: 35, queda: 25, saldo: 15, ciclo: 15, campanhas: 10 } as const;
/** Intervalo normal assumido para quem tem menos de 2 usos no período (não dá para medir o próprio). */
const INTERVALO_PADRAO_DIAS = 30;
const INTERVALO_MIN = 3;
const INTERVALO_MAX = 60;

export interface EntradaRisco {
  limiteTotal: number;
  saldoDisponivel: number;
  /** Dias entre o último uso e o último dia do extrato (null = nunca usou). */
  diasSemUso: number | null;
  usosTotal: number;
  usosUltimos90d: number;
  /** Usos nos 30 dias até o fim do extrato e nos 60 dias anteriores a esses. */
  usos30: number;
  usos60Anteriores: number;
  /** Dias desde a última abertura do ciclo da cidade (null = cidade sem ciclo cadastrado). */
  diasDesdeAbertura: number | null;
  /** O cliente usou depois da última abertura do ciclo. */
  usouDesdeAbertura: boolean;
  enviadas90d: number;
  respondeu90d: number;
}

export interface MotivoRisco {
  key: keyof typeof PESOS;
  pontos: number;
  texto: string;
}

export interface ResultadoRisco {
  elegivel: boolean;
  nota: number;
  nivel: NivelRisco;
  motivos: MotivoRisco[];
  /** Motivo de maior peso (para a lista). */
  principal: string | null;
  confianca: ConfiancaRisco;
}

const clamp = (n: number, min = 0, max = 1) => Math.min(max, Math.max(min, n));
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Intervalo normal entre usos do cliente, em dias. */
export function intervaloNormal(usosUltimos90d: number): { dias: number; medido: boolean } {
  if (usosUltimos90d >= 2) return { dias: Math.round(clamp(90 / usosUltimos90d, INTERVALO_MIN, INTERVALO_MAX)), medido: true };
  return { dias: INTERVALO_PADRAO_DIAS, medido: false };
}

export function nivelDe(nota: number): NivelRisco {
  return nota >= NIVEL_ALTO ? "alto" : nota >= NIVEL_MEDIO ? "medio" : "baixo";
}

export function pontuarRisco(e: EntradaRisco, extratoEmDia: boolean): ResultadoRisco {
  const naoElegivel: ResultadoRisco = { elegivel: false, nota: 0, nivel: "baixo", motivos: [], principal: null, confianca: "baixa" };
  if (!(e.limiteTotal > 0) || e.usosTotal < 1 || e.diasSemUso === null) return naoElegivel;

  const motivos: MotivoRisco[] = [];
  const { dias: intervalo, medido } = intervaloNormal(e.usosUltimos90d);

  // 1) atraso: 1× o intervalo = 0 ponto; 3× ou mais = peso cheio
  const razao = e.diasSemUso / intervalo;
  const atraso = PESOS.atraso * clamp((razao - 1) / 2);
  if (atraso > 0) motivos.push({ key: "atraso", pontos: atraso, texto: `Há ${e.diasSemUso} dias sem usar, ${r1(razao)}× o intervalo normal (${intervalo} dias)` });

  // 2) queda de frequência: só com base (usos nos 60 dias anteriores)
  let queda = 0;
  if (e.usos60Anteriores > 0) {
    const esperado30 = e.usos60Anteriores / 2;
    queda = PESOS.queda * clamp(1 - e.usos30 / esperado30);
    if (queda > 0) motivos.push({ key: "queda", pontos: queda, texto: `Usou ${e.usos30}× nos últimos 30 dias, contra ${r1(esperado30)}× por mês antes` });
  }

  // 3) saldo parado: só conta se já está atrasado (saldo alto de quem usou ontem não é sinal)
  let saldo = 0;
  const saldoPct = e.saldoDisponivel / e.limiteTotal;
  if (razao > 1) {
    saldo = PESOS.saldo * clamp((saldoPct - 0.3) / 0.7);
    if (saldo > 0) motivos.push({ key: "saldo", pontos: saldo, texto: `${Math.round(clamp(saldoPct) * 100)}% do limite disponível e parado` });
  }

  // 4) ciclo: o limite renovou e não usou (1–2 dias ainda é cedo: metade do peso)
  let ciclo = 0;
  if (e.diasDesdeAbertura !== null && !e.usouDesdeAbertura && e.diasDesdeAbertura >= 1) {
    ciclo = e.diasDesdeAbertura >= 3 ? PESOS.ciclo : PESOS.ciclo / 2;
    motivos.push({ key: "ciclo", pontos: ciclo, texto: `O ciclo da cidade abriu há ${e.diasDesdeAbertura} dia${e.diasDesdeAbertura === 1 ? "" : "s"} e ele não usou` });
  }

  // 5) campanhas: recebeu 2+ mensagens e quase não respondeu
  let camp = 0;
  if (e.enviadas90d >= 2) {
    const taxa = e.respondeu90d / e.enviadas90d;
    camp = taxa === 0 ? PESOS.campanhas : taxa < 0.2 ? PESOS.campanhas / 2 : 0;
    if (camp > 0) motivos.push({ key: "campanhas", pontos: camp, texto: `Recebeu ${e.enviadas90d} mensagens e respondeu a ${e.respondeu90d}` });
  }

  const nota = Math.round(clamp(atraso + queda + saldo + ciclo + camp, 0, 100));
  motivos.sort((a, b) => b.pontos - a.pontos);
  const confianca: ConfiancaRisco = !extratoEmDia ? "baixa" : medido && e.usosUltimos90d >= 3 ? "alta" : "media";
  return {
    elegivel: true,
    nota,
    nivel: nivelDe(nota),
    motivos: motivos.map((m) => ({ ...m, pontos: r1(m.pontos) })),
    principal: motivos[0]?.texto ?? null,
    confianca,
  };
}

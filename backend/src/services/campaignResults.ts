import { AppPrismaClient } from "../config/db";
import { computeABSignificance } from "./statistics";

/**
 * Resultado de campanha medido pelo USO REAL do cliente (transações), não pela renovação de
 * limite. Regras (confirmadas com o cliente, 2026-10-10):
 *  - conta como uso só antecipação e compra (Transaction.countsAsUsage); assinatura e tipos
 *    desconhecidos nunca;
 *  - curva de conversão em D0, D1, D3, D7, D14 e D30, em DIAS DE CALENDÁRIO de Brasília
 *    (D0 = "no mesmo dia do disparo", a partir da hora do envio);
 *  - quando o cliente recebe mais de uma campanha, o uso conta para a MAIS RECENTE;
 *  - quem tinha saldo disponível na data do envio é separado de quem não tinha (sem saldo não há
 *    como usar), usando o histórico AccountSnapshot;
 *  - grupo de controle opcional (MessageStatus.CONTROLE): clientes do público que não receberam a
 *    mensagem, para medir o lift real.
 *
 * Tudo é calculado na hora da consulta a partir das transações — não há estado de atribuição
 * guardado que possa ficar velho: um uso importado dias depois entra no relatório sozinho.
 *
 * As funções puras (sem banco) ficam no topo; o carregamento do banco, no fim.
 */

export const HORIZONS = [0, 1, 3, 7, 14, 30] as const;
export const MAX_DAY = 30;

/**
 * Saldo disponível mínimo (R$) para considerar que o cliente PODIA usar no dia do envio. A
 * planilha traz saldos residuais como R$ 0,01 e R$ 1,56 (limite praticamente esgotado), e as
 * menores operações do extrato são de dezenas de reais.
 */
export const MIN_SALDO_ELEGIVEL = 10;

const DAY_MS = 24 * 3600 * 1000;
const BRASILIA_OFFSET_MS = 3 * 3600 * 1000;

export type Cohort = "TRATADO" | "CONTROLE";
export type SaldoGroup = "COM_SALDO" | "SEM_SALDO" | "DESCONHECIDO";
export type UsageKind = "ANTECIPACAO" | "COMPRA";

export interface UsageTx {
  clientId: string;
  confirmedAt: Date;
  kind: UsageKind;
  valorPrincipal: number;
  juros: number;
}

export interface CreditedTx extends UsageTx {
  /** dias de calendário (Brasília) entre o envio e a transação; 0 = mesmo dia */
  dayOffset: number;
}

export interface SaldoPoint {
  recordedAt: Date;
  saldoDisponivel: number;
}

export interface EvaluableEvent {
  id: string;
  clientId: string;
  variant: string;
  cohort: Cohort;
  /** momento do envio (tratados) ou o equivalente atribuído (controle) */
  ref: Date;
}

export interface EventEvaluation extends EvaluableEvent {
  saldoNoEnvio: number | null;
  grupoSaldo: SaldoGroup;
  usos: CreditedTx[];
  /** dia (offset) do primeiro uso creditado; null = não usou na janela de 30 dias */
  primeiroUsoDia: number | null;
}

/** Índice do dia de calendário em Brasília (UTC-3, sem horário de verão). */
export function brasiliaDay(d: Date): number {
  return Math.floor((d.getTime() - BRASILIA_OFFSET_MS) / DAY_MS);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * O controle não recebe mensagem, então não tem "momento de envio". Para a comparação ser justa
 * quando o disparo se espalha por dias (throttle, cron diário), cada cliente de controle recebe
 * o momento de um envio real, casado por posição na distribuição dos envios (quantis) e ordem
 * estável de id — a janela de medição do controle fica com o mesmo perfil de datas do tratado.
 */
export function assignControlRefs(treatedRefs: Date[], controlIds: string[]): Map<string, Date> {
  const out = new Map<string, Date>();
  if (treatedRefs.length === 0) return out;
  const sorted = [...treatedRefs].sort((a, b) => a.getTime() - b.getTime());
  const ids = [...controlIds].sort();
  ids.forEach((id, k) => {
    const idx = Math.min(sorted.length - 1, Math.floor(((k + 0.5) / ids.length) * sorted.length));
    out.set(id, sorted[idx]);
  });
  return out;
}

/** Saldo na data `ref`: a última linha de histórico com recordedAt <= ref (pontos em ordem crescente). */
export function saldoAsOf(points: SaldoPoint[] | undefined, ref: Date): number | null {
  if (!points || points.length === 0) return null;
  let found: SaldoPoint | null = null;
  for (const p of points) {
    if (p.recordedAt.getTime() <= ref.getTime()) found = p;
    else break;
  }
  return found ? found.saldoDisponivel : null;
}

export function saldoGroup(saldo: number | null): SaldoGroup {
  if (saldo === null) return "DESCONHECIDO";
  return saldo >= MIN_SALDO_ELEGIVEL ? "COM_SALDO" : "SEM_SALDO";
}

/**
 * Usos do cliente creditados a este envio: ocorrem a partir de `ref`, em até 30 dias de
 * calendário, e NÃO depois de uma mensagem de outra campanha (essa passa a ser a "mais recente"
 * e leva o crédito). `otherRefs` = momentos em que o mesmo cliente recebeu outras campanhas.
 */
export function creditedUsage(ref: Date, txs: UsageTx[], otherRefs: Date[]): CreditedTx[] {
  const refDay = brasiliaDay(ref);
  const out: CreditedTx[] = [];
  for (const tx of txs) {
    if (tx.confirmedAt.getTime() < ref.getTime()) continue;
    const dayOffset = brasiliaDay(tx.confirmedAt) - refDay;
    if (dayOffset > MAX_DAY) continue;
    const stolen = otherRefs.some((r) => r.getTime() > ref.getTime() && r.getTime() <= tx.confirmedAt.getTime());
    if (stolen) continue;
    out.push({ ...tx, dayOffset });
  }
  return out.sort((a, b) => a.confirmedAt.getTime() - b.confirmedAt.getTime());
}

export interface EvaluationInputs {
  events: EvaluableEvent[];
  txByClient: Map<string, UsageTx[]>;
  /** envios de OUTRAS campanhas (não sandbox) por cliente */
  otherRefsByClient: Map<string, Date[]>;
  saldoByClient: Map<string, SaldoPoint[]>;
}

export function evaluateEvents(input: EvaluationInputs): EventEvaluation[] {
  return input.events.map((ev) => {
    const usos = creditedUsage(ev.ref, input.txByClient.get(ev.clientId) ?? [], input.otherRefsByClient.get(ev.clientId) ?? []);
    const saldoNoEnvio = saldoAsOf(input.saldoByClient.get(ev.clientId), ev.ref);
    return {
      ...ev,
      saldoNoEnvio,
      grupoSaldo: saldoGroup(saldoNoEnvio),
      usos,
      primeiroUsoDia: usos.length > 0 ? usos[0].dayOffset : null,
    };
  });
}

export interface WindowStats {
  n: number;
  convertidos: number;
  /** 0-1 */
  taxa: number;
  usos: number;
  antecipacoes: { qtd: number; valor: number; lucro: number };
  /** compra à vista: o lucro (taxa do comerciante) não é conhecido — fica ausente, não zero */
  compras: { qtd: number; valor: number };
  valorMovimentado: number;
  /** só Juros de antecipação */
  lucro: number;
}

/** Estatísticas acumuladas até o dia `day` (inclusive) após o envio. */
export function statsAtDay(evals: EventEvaluation[], day: number): WindowStats {
  let convertidos = 0;
  let usos = 0;
  const ant = { qtd: 0, valor: 0, lucro: 0 };
  const cmp = { qtd: 0, valor: 0 };
  for (const e of evals) {
    const within = e.usos.filter((u) => u.dayOffset <= day);
    if (within.length > 0) convertidos++;
    for (const u of within) {
      usos++;
      if (u.kind === "ANTECIPACAO") {
        ant.qtd++;
        ant.valor += u.valorPrincipal;
        ant.lucro += u.juros;
      } else {
        cmp.qtd++;
        cmp.valor += u.valorPrincipal;
      }
    }
  }
  const n = evals.length;
  return {
    n,
    convertidos,
    taxa: n > 0 ? convertidos / n : 0,
    usos,
    antecipacoes: { qtd: ant.qtd, valor: round2(ant.valor), lucro: round2(ant.lucro) },
    compras: { qtd: cmp.qtd, valor: round2(cmp.valor) },
    valorMovimentado: round2(ant.valor + cmp.valor),
    lucro: round2(ant.lucro),
  };
}

export interface CurvePoint extends WindowStats {
  dia: number;
  /** quantos envios já completaram `dia` dias — abaixo de n, o ponto ainda é parcial */
  maduros: number;
}

export function buildCurve(evals: EventEvaluation[], now: Date): CurvePoint[] {
  const today = brasiliaDay(now);
  return HORIZONS.map((dia) => ({
    dia,
    maduros: evals.filter((e) => today - brasiliaDay(e.ref) >= dia).length,
    ...statsAtDay(evals, dia),
  }));
}

export interface LiftPoint {
  dia: number;
  taxaTratados: number;
  taxaControle: number;
  /** pontos percentuais (taxaTratados - taxaControle) * 100 */
  liftPontos: number;
  pValue: number | null;
  significativo95: boolean;
  dadosInsuficientes: boolean;
  /** lucro a mais que os tratados geraram em relação ao esperado pelo controle (Juros) */
  lucroIncremental: number;
}

/** Compara tratados x controle até o dia `dia` (teste de duas proporções + lucro incremental). */
export function liftAtDay(treated: EventEvaluation[], control: EventEvaluation[], dia: number): LiftPoint {
  const t = statsAtDay(treated, dia);
  const c = statsAtDay(control, dia);
  const sig = computeABSignificance(t.n, t.convertidos, c.n, c.convertidos);
  const lucroPerCapitaT = t.n > 0 ? t.lucro / t.n : 0;
  const lucroPerCapitaC = c.n > 0 ? c.lucro / c.n : 0;
  return {
    dia,
    taxaTratados: t.taxa,
    taxaControle: c.taxa,
    liftPontos: round2((t.taxa - c.taxa) * 100),
    pValue: sig.pValue !== null ? Number(sig.pValue.toFixed(4)) : null,
    significativo95: sig.significant95,
    dadosInsuficientes: sig.insufficientData,
    lucroIncremental: round2((lucroPerCapitaT - lucroPerCapitaC) * t.n),
  };
}

export function buildLift(treated: EventEvaluation[], control: EventEvaluation[]): LiftPoint[] {
  return HORIZONS.map((dia) => liftAtDay(treated, control, dia));
}

export interface CohortCurves {
  total: CurvePoint[];
  porSaldo: Record<SaldoGroup, CurvePoint[]>;
  porSaldoN: Record<SaldoGroup, number>;
}

const SALDO_GROUPS: SaldoGroup[] = ["COM_SALDO", "SEM_SALDO", "DESCONHECIDO"];

function cohortCurves(evals: EventEvaluation[], now: Date): CohortCurves {
  const porSaldo = {} as Record<SaldoGroup, CurvePoint[]>;
  const porSaldoN = {} as Record<SaldoGroup, number>;
  for (const g of SALDO_GROUPS) {
    const subset = evals.filter((e) => e.grupoSaldo === g);
    porSaldo[g] = buildCurve(subset, now);
    porSaldoN[g] = subset.length;
  }
  return { total: buildCurve(evals, now), porSaldo, porSaldoN };
}

export interface CampaignResults {
  horizontes: readonly number[];
  minSaldoElegivel: number;
  tratados: CohortCurves;
  controle: CohortCurves | null;
  /** lift sobre todos e sobre quem tinha saldo (a comparação mais justa); null sem controle */
  lift: { total: LiftPoint[]; comSaldo: LiftPoint[] } | null;
}

export function buildCampaignResults(evals: EventEvaluation[], now: Date = new Date()): CampaignResults {
  const treated = evals.filter((e) => e.cohort === "TRATADO");
  const control = evals.filter((e) => e.cohort === "CONTROLE");
  const hasControl = control.length > 0;
  return {
    horizontes: HORIZONS,
    minSaldoElegivel: MIN_SALDO_ELEGIVEL,
    tratados: cohortCurves(treated, now),
    controle: hasControl ? cohortCurves(control, now) : null,
    lift: hasControl
      ? {
          total: buildLift(treated, control),
          comSaldo: buildLift(
            treated.filter((e) => e.grupoSaldo === "COM_SALDO"),
            control.filter((e) => e.grupoSaldo === "COM_SALDO")
          ),
        }
      : null,
  };
}

/* ───────────────────────── carregamento do banco ───────────────────────── */

const SENT_STATUSES = ["ENVIADO", "ENTREGUE", "LIDO", "RESPONDIDO"] as const;
const BATCH = 1000;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Carrega eventos, transações, envios de outras campanhas e histórico de saldo da campanha e
 * devolve a avaliação de cada evento (enviados + controle). O chamador já verificou que a
 * campanha pertence ao tenant. Eventos sem envio (fila, falha, bloqueado) não entram: não têm
 * momento de referência.
 */
export async function loadCampaignEvaluations(
  prisma: AppPrismaClient,
  tenantId: string,
  campaignId: string
): Promise<EventEvaluation[]> {
  const rawEvents = await prisma.messageEvent.findMany({
    where: { campaignId, status: { in: [...SENT_STATUSES, "CONTROLE"] } },
    select: { id: true, clientId: true, variant: true, status: true, sentAt: true },
  });

  const treated = rawEvents.filter((e) => e.status !== "CONTROLE" && e.sentAt);
  const controlRaw = rawEvents.filter((e) => e.status === "CONTROLE");
  const controlRefs = assignControlRefs(
    treated.map((e) => e.sentAt!),
    controlRaw.map((e) => e.id)
  );

  const events: EvaluableEvent[] = [
    ...treated.map((e) => ({ id: e.id, clientId: e.clientId, variant: e.variant, cohort: "TRATADO" as const, ref: e.sentAt! })),
    ...controlRaw
      .filter((e) => controlRefs.has(e.id))
      .map((e) => ({ id: e.id, clientId: e.clientId, variant: e.variant, cohort: "CONTROLE" as const, ref: controlRefs.get(e.id)! })),
  ];
  if (events.length === 0) return [];

  const refs = events.map((e) => e.ref.getTime());
  const minRef = new Date(Math.min(...refs));
  const maxRef = new Date(Math.max(...refs));
  const windowEnd = new Date(maxRef.getTime() + (MAX_DAY + 2) * DAY_MS);
  const clientIds = [...new Set(events.map((e) => e.clientId))];

  const txByClient = new Map<string, UsageTx[]>();
  const otherRefsByClient = new Map<string, Date[]>();
  const saldoByClient = new Map<string, SaldoPoint[]>();

  for (const ids of chunk(clientIds, BATCH)) {
    const [txs, others, snaps] = await Promise.all([
      prisma.transaction.findMany({
        where: { tenantId, clientId: { in: ids }, countsAsUsage: true, confirmedAt: { gte: minRef, lte: windowEnd } },
        select: { clientId: true, confirmedAt: true, kind: true, valorPrincipal: true, juros: true },
      }),
      prisma.messageEvent.findMany({
        where: {
          clientId: { in: ids },
          campaignId: { not: campaignId },
          status: { in: [...SENT_STATUSES] },
          sentAt: { gte: minRef, lte: windowEnd },
          campaign: { tenantId, isSandbox: false },
        },
        select: { clientId: true, sentAt: true },
      }),
      prisma.accountSnapshot.findMany({
        where: { tenantId, clientId: { in: ids }, recordedAt: { lte: maxRef } },
        select: { clientId: true, recordedAt: true, saldoDisponivel: true },
        orderBy: { recordedAt: "asc" },
      }),
    ]);

    for (const t of txs) {
      if (!t.clientId) continue;
      const list = txByClient.get(t.clientId) ?? [];
      list.push({
        clientId: t.clientId,
        confirmedAt: t.confirmedAt,
        kind: t.kind as UsageKind,
        valorPrincipal: Number(t.valorPrincipal),
        juros: Number(t.juros),
      });
      txByClient.set(t.clientId, list);
    }
    for (const o of others) {
      if (!o.sentAt) continue;
      const list = otherRefsByClient.get(o.clientId) ?? [];
      list.push(o.sentAt);
      otherRefsByClient.set(o.clientId, list);
    }
    for (const s of snaps) {
      const list = saldoByClient.get(s.clientId) ?? [];
      list.push({ recordedAt: s.recordedAt, saldoDisponivel: Number(s.saldoDisponivel) });
      saldoByClient.set(s.clientId, list);
    }
  }

  return evaluateEvents({ events, txByClient, otherRefsByClient, saldoByClient });
}

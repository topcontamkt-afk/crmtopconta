import { randomUUID } from "node:crypto";
import { AppPrismaClient } from "../config/db";

/**
 * Proteções do disparo contra envio em duplicidade (incidente de 22/10/2026: 12 chamadas de /dispatch ao mesmo
 * tempo leram os mesmos itens da fila e cada pessoa recebeu até 10 cópias). Três camadas:
 *  1) trava por campanha: só um disparo por vez (`Campaign.dispatchToken/dispatchUntil`, um UPDATE condicional,
 *     atômico no SQLite/D1 e no Postgres);
 *  2) reserva dos itens (`MessageEvent.claimToken/claimedAt`) antes de enviar: dois disparos nunca pegam o mesmo;
 *  3) orçamento de tempo e erro de infraestrutura: o que não deu tempo, ou falhou por limite do Worker, volta à fila
 *     (nunca vira FALHA, que é definitiva).
 */

/** Máximo de mensagens por chamada de disparo. */
export const DISPATCH_LOTE_MAX = 25;
/** A trava da campanha expira sozinha (chamada que morreu no meio não prende a campanha para sempre). */
export const LOCK_MS = 90_000;
/**
 * Reserva de item parada há mais que isto é considerada abandonada e o item volta a ser elegível. É longa de propósito:
 * se a mensagem JÁ saiu e só o registro falhou, reenviar cedo duplicaria o envio.
 */
export const CLAIM_STALE_MS = 30 * 60_000;
/** Tempo máximo gasto enviando numa chamada; passou disso, devolve o resto à fila. */
export const ORCAMENTO_MS_PADRAO = 20_000;

export const STATUS_ENVIADOS = ["ENVIADO", "ENTREGUE", "LIDO", "RESPONDIDO"] as const;

export function orcamentoMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.DISPATCH_ORCAMENTO_MS);
  return v > 0 ? v : ORCAMENTO_MS_PADRAO;
}

/** Erro que é limite da plataforma (Worker), não problema do contato: a mensagem deve continuar na fila. */
export function erroDeInfra(msg: string | null | undefined): boolean {
  return /too many subrequests|exceeded cpu|exceeded.{0,20}(memory|time limit)|worker exceeded/i.test(msg ?? "");
}

/** Tenta assumir o disparo da campanha. Devolve o token da trava, ou null se já há um disparo em andamento. */
export async function acquireDispatchLock(prisma: AppPrismaClient, campaignId: string, now = new Date()): Promise<string | null> {
  const token = randomUUID();
  const r = await prisma.campaign.updateMany({
    where: { id: campaignId, OR: [{ dispatchUntil: null }, { dispatchUntil: { lt: now } }] },
    data: { dispatchToken: token, dispatchUntil: new Date(now.getTime() + LOCK_MS) },
  });
  return r.count > 0 ? token : null;
}

export async function releaseDispatchLock(prisma: AppPrismaClient, campaignId: string, token: string): Promise<void> {
  await prisma.campaign.updateMany({ where: { id: campaignId, dispatchToken: token }, data: { dispatchToken: null, dispatchUntil: null } }).catch((e) => console.warn("[dispatch] não liberou a trava:", (e as Error).message));
}

/** Reserva até `batchSize` itens da fila para este disparo e devolve o token da reserva. */
export async function claimEvents(prisma: AppPrismaClient, campaignId: string, batchSize: number, now = new Date()): Promise<string> {
  const token = randomUUID();
  const stale = new Date(now.getTime() - CLAIM_STALE_MS);
  const livre = { OR: [{ claimedAt: null }, { claimedAt: { lt: stale } }] };
  const candidatos = await prisma.messageEvent.findMany({ where: { campaignId, status: "FILA", ...livre }, take: batchSize, select: { id: true } });
  if (candidatos.length > 0) {
    // o `status: FILA` e a condição de reserva livre se repetem: se outro disparo reservou nesse meio tempo, não rouba
    await prisma.messageEvent.updateMany({ where: { id: { in: candidatos.map((c) => c.id) }, status: "FILA", ...livre }, data: { claimToken: token, claimedAt: now } });
  }
  return token;
}

/** Devolve à fila os itens reservados por este disparo que não foram processados. */
export async function releaseClaims(prisma: AppPrismaClient, campaignId: string, token: string, exceto: string[] = []): Promise<void> {
  await prisma.messageEvent.updateMany({ where: { campaignId, claimToken: token, status: "FILA", ...(exceto.length ? { id: { notIn: exceto } } : {}) }, data: { claimToken: null, claimedAt: null } }).catch((e) => console.warn("[dispatch] não devolveu a reserva:", (e as Error).message));
}

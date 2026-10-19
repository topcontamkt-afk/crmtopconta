import { randomUUID } from "node:crypto";
import { prisma } from "../config/db";
import { runWithTenantContextAsync } from "../config/tenantGuard";
import { logAudit } from "../middleware/audit";
import { refreshCicloColumns } from "./cicloRefresh";
import { ColumnMapping, fetchSheetPage, fetchSheetRows, resolveTenantSheet } from "./googleSheets";
import { runImport } from "./importService";
import { notify } from "./notifications";

/**
 * Sincronização da planilha Google em páginas, por uma Cloudflare Queue (vale no plano grátis: 10 mil operações/dia).
 *
 * No Worker uma invocação tem teto de CPU e de consultas ao D1, e uma importação de 400 linhas já gasta ~500
 * consultas (ver importQueries.int.test.ts). A planilha inteira numa invocação só não cabe; então cada mensagem
 * da fila é UMA página de `SYNC_CHUNK` linhas: o consumidor lê do Google só aquela página, importa e, se ela veio
 * cheia, põe a próxima na fila. A mensagem leva só a posição (tenant, planilha, range, linha inicial) e contagens,
 * nunca dado da planilha: nenhum CPF ou telefone fica guardado na fila.
 *
 * Sem fila configurada (Node: servidor local, testes) roda tudo de uma vez, como antes.
 *
 * Diferença do sync de uma vez: a proteção "coluna ausente não zera" (importService.ts, PROTEGIDOS) é decidida por
 * página. Uma coluna vazia em todas as linhas de uma página não zera aqueles clientes, mesmo que outras páginas
 * tenham valor nela (erra para o lado de não apagar).
 */

export const SYNC_CHUNK = 200;
/** Teto de páginas por sincronização (200 × 250 = 50 mil linhas): uma planilha maior para aqui e avisa. */
export const SYNC_MAX_PAGINAS = 250;
/** Tentativas de cada mensagem: `max_retries` (3) do consumidor no wrangler.jsonc + a primeira. */
export const SYNC_MAX_TENTATIVAS = 4;

export interface PaginaSync {
  tenantId: string;
  sheetId: string;
  range: string;
  mapping: ColumnMapping;
  /** linha de dados inicial da página (0 = primeira depois do cabeçalho) */
  inicio: number;
  loteId: string;
  triggeredBy: string;
  /** quem pediu (sync manual); o agendado não tem usuário */
  userId?: string;
  totais: { paginas: number; linhas: number; adicionados: number; atualizados: number; erros: number };
}

export interface SyncQueue {
  send(msg: PaginaSync): Promise<void>;
}

let fila: SyncQueue | null = null;

/** Worker: binding `SYNC_QUEUE` (worker/index.ts). Sem chamar, o sync roda inteiro na mesma invocação. */
export function configureSyncQueue(q: SyncQueue | null): void {
  fila = q;
}

export interface SyncPedido {
  tenantId: string;
  sheetId: string;
  range: string;
  mapping: ColumnMapping;
  triggeredBy: string;
  userId?: string;
}

export type SyncInicio =
  | { enfileirado: true; loteId: string }
  | { enfileirado: false; importJobId: string; result: Awaited<ReturnType<typeof runImport>>["result"] };

/**
 * Começa a sincronização (no contexto do tenant). Com fila: põe a 1ª página e volta na hora. Sem fila: lê e
 * importa a planilha inteira, atualiza `lastSyncAt` e o ciclo das cidades, e devolve o resultado.
 */
export async function iniciarSyncPlanilha(p: SyncPedido): Promise<SyncInicio> {
  if (fila) {
    const loteId = randomUUID();
    await fila.send({ ...p, inicio: 0, loteId, totais: { paginas: 0, linhas: 0, adicionados: 0, atualizados: 0, erros: 0 } });
    return { enfileirado: true, loteId };
  }
  const rows = await fetchSheetRows(p.sheetId, p.range, p.mapping);
  const { importJobId, result } = await runImport(prisma, p.tenantId, rows, p.triggeredBy, "google_sheets", p.sheetId);
  await concluir(p.tenantId, p.sheetId);
  return { enfileirado: false, importJobId, result };
}

async function concluir(tenantId: string, sheetId: string) {
  await prisma.sheetConnection.updateMany({ where: { tenantId, sheetId, active: true }, data: { lastSyncAt: new Date() } });
  await refreshCicloColumns(tenantId).catch((e) => console.error("[sheetSync] ciclos:", e));
}

/**
 * Uma página (consumidor da fila). Confere de novo que a planilha é do tenant (a conexão pode ter mudado entre
 * uma página e outra), importa e encadeia a próxima. Lança em caso de erro, para a fila tentar de novo: reimportar
 * a mesma página é seguro (a última atualização ganha; só fica um ImportJob a mais no lote).
 */
export async function processarPaginaSync(msg: PaginaSync): Promise<{ proxima: boolean }> {
  return runWithTenantContextAsync(msg.tenantId, async () => {
    await resolveTenantSheet(prisma, msg.tenantId, msg.sheetId);
    const { linhas, primeiraLinha } = await fetchSheetPage(msg.sheetId, msg.range, msg.mapping, msg.inicio, SYNC_CHUNK);
    const totais = { ...msg.totais };
    if (linhas.length) {
      const { result } = await runImport(prisma, msg.tenantId, linhas, msg.triggeredBy, "google_sheets", msg.sheetId, {
        loteId: msg.loteId,
        primeiraLinha,
      });
      totais.paginas++;
      totais.linhas += linhas.length;
      totais.adicionados += result.addedCount;
      totais.atualizados += result.updatedCount;
      totais.erros += result.errorCount;
    }

    const cheia = linhas.length === SYNC_CHUNK;
    if (cheia && totais.paginas < SYNC_MAX_PAGINAS && fila) {
      await fila.send({ ...msg, inicio: msg.inicio + SYNC_CHUNK, totais });
      return { proxima: true };
    }

    await concluir(msg.tenantId, msg.sheetId);
    await logAudit({
      tenantId: msg.tenantId,
      userId: msg.userId,
      action: "IMPORT_GOOGLE_SHEETS",
      target: "ImportLote",
      targetId: msg.loteId,
      details: { ...totais, enfileirado: true },
    });
    if (cheia) {
      await notify(prisma, {
        tenantId: msg.tenantId,
        type: "IMPORT_FAILED",
        severity: "ERRO",
        message: `Sincronização da planilha ${msg.sheetId} parou em ${totais.linhas} linhas (limite de ${SYNC_MAX_PAGINAS} páginas de ${SYNC_CHUNK}).`,
      });
    }
    return { proxima: false };
  });
}

/**
 * Entrada do consumidor: "ok" (ack) ou "retry". Na última tentativa o erro vira notificação para o tenant e a
 * mensagem sai da fila (o detalhe do erro fica só no log).
 */
export async function tratarMensagemSync(msg: PaginaSync, tentativa: number): Promise<"ok" | "retry"> {
  try {
    await processarPaginaSync(msg);
    return "ok";
  } catch (e) {
    console.error(`[sheetSync] lote ${msg.loteId}, linha ${msg.inicio}, tentativa ${tentativa}:`, e);
    if (tentativa < SYNC_MAX_TENTATIVAS) return "retry";
    await runWithTenantContextAsync(msg.tenantId, async () => {
      await notify(prisma, {
        tenantId: msg.tenantId,
        type: "IMPORT_FAILED",
        severity: "ERRO",
        message: `Sincronização da planilha ${msg.sheetId} falhou a partir da linha ${msg.inicio + 2}: ${e instanceof Error ? e.message : String(e)}`,
      });
    }).catch((err) => console.error("[sheetSync] notificação:", err));
    return "ok";
  }
}

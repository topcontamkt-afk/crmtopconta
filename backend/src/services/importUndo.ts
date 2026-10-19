import { AppPrismaClient } from "../config/db";

/**
 * Desfazer um lote de importação de clientes. Cada cliente que a importação alterou ou criou deixou um
 * ImportChange com o estado de ANTES (só as colunas gravadas). Desfazer restaura esses valores, apaga os
 * clientes que a importação criou (se ainda não têm histórico próprio), as linhas de histórico de saldo
 * (AccountSnapshot) e as renovações de limite que ela gerou. Em lotes de poucas centenas por chamada,
 * porque a função serverless tem tempo limitado: a tela repete até `restantes` chegar a zero.
 */

export const UNDO_BATCH = 300;
/** LGPD 04-04: o estado anterior só serve para desfazer, e só por este prazo (o job de retenção apaga o resto). */
export const IMPORT_CHANGE_TTL_DIAS = 30;
export const UNDOABLE_FORMATS = ["cartoes", "generico"];

const DATE_FIELDS = ["dataCadastro", "dataAberturaConta", "dataUltimaUtilizacao", "dataValidadeCartao", "dataNascimento", "encerradoEm", "optOutAt", "anonymizedAt"];

/** O estado anterior volta do JSON com datas em texto: converte de novo para Date antes de gravar. */
export function reviveBefore(before: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...before };
  for (const f of DATE_FIELDS) {
    const v = out[f];
    if (typeof v === "string") out[f] = new Date(v);
  }
  return out;
}

export class UndoError extends Error {
  constructor(public status: number, message: string, public codigo: string) {
    super(message);
  }
}

export interface UndoResult {
  restaurados: number;
  /** LGPD 04-04: clientes anonimizados, bloqueados ou com documento eliminado: o estado anterior NÃO volta */
  protegidos: number;
  removidos: number;
  mantidos: number;
  ausentes: number;
  restantes: number;
  concluido: boolean;
}

async function loadLote(prisma: AppPrismaClient, tenantId: string, loteId: string) {
  let jobs = await prisma.importJob.findMany({ where: { tenantId, loteId } });
  if (jobs.length === 0) jobs = await prisma.importJob.findMany({ where: { tenantId, id: loteId } }); // importação sem lote: o próprio id
  return jobs;
}

/** Confere se este lote pode ser desfeito agora; lança UndoError com o motivo. Devolve os jobs do lote. */
export async function assertUndoable(prisma: AppPrismaClient, tenantId: string, loteId: string) {
  const jobs = await loadLote(prisma, tenantId, loteId);
  if (jobs.length === 0) throw new UndoError(404, "Importação não encontrada.", "NAO_ENCONTRADA");
  const formato = jobs[0].formato;
  if (!formato || !UNDOABLE_FORMATS.includes(formato)) throw new UndoError(409, "Só importações de clientes (Cartões e contas / Genérico) podem ser desfeitas.", "FORMATO_SEM_DESFAZER");
  if (jobs.every((j) => j.desfeitaEm)) throw new UndoError(409, "Esta importação já foi desfeita.", "JA_DESFEITA");
  const ids = jobs.map((j) => j.id);
  const inicio = new Date(Math.min(...jobs.map((j) => j.startedAt.getTime())));
  const fim = new Date(Math.max(...jobs.map((j) => j.startedAt.getTime())));
  // Só a última: desfazer uma importação antiga passaria por cima do que as seguintes gravaram.
  const posterior = await prisma.importJob.findFirst({
    where: { tenantId, formato: { in: UNDOABLE_FORMATS }, desfeitaEm: null, startedAt: { gt: fim }, id: { notIn: ids } },
    select: { id: true },
  });
  if (posterior) throw new UndoError(409, "Só dá para desfazer a última importação de clientes. Desfaça primeiro as mais recentes.", "NAO_E_A_ULTIMA");
  const restantes = await prisma.importChange.count({ where: { tenantId, importJobId: { in: ids } } });
  if (restantes === 0) throw new UndoError(409, "Não há mais o estado anterior desta importação (guardamos por 30 dias).", "EXPIRADA");
  return { jobs, ids, inicio, restantes };
}

export async function undoLoteBatch(prisma: AppPrismaClient, tenantId: string, userId: string, loteId: string, limit = UNDO_BATCH): Promise<UndoResult> {
  const { ids, inicio } = await assertUndoable(prisma, tenantId, loteId);

  const changes = await prisma.importChange.findMany({ where: { tenantId, importJobId: { in: ids } }, take: limit, orderBy: { id: "asc" } });

  // LGPD 04-04: desfazer nunca reidentifica. Quem foi anonimizado (ou bloqueado a pedido) depois da importação,
  // ou cujo documento de antes está suprimido por eliminação, não recebe o estado anterior de volta.
  const atualizados = changes.filter((c) => c.kind === "ATUALIZADO" && c.before);
  const protegidosIds = new Set<string>();
  if (atualizados.length) {
    const clientes = await prisma.client.findMany({
      where: { tenantId, id: { in: atualizados.map((c) => c.clientId) } },
      select: { id: true, anonymizedAt: true, bloqueadoLgpdAt: true, cpfHash: true },
    });
    for (const c of clientes) if (c.anonymizedAt || c.bloqueadoLgpdAt || c.cpfHash.startsWith("anon-")) protegidosIds.add(c.id);
    const docsAntes = [...new Set(atualizados.map((c) => (c.before as Record<string, unknown>).cpfHash).filter((d): d is string => typeof d === "string"))];
    if (docsAntes.length) {
      const eliminados = await prisma.supressaoTitular.findMany({ where: { tenantId, motivo: "ELIMINACAO", docHash: { in: docsAntes } }, select: { docHash: true } });
      const set = new Set(eliminados.map((e) => e.docHash));
      for (const c of atualizados) if (set.has((c.before as Record<string, unknown>).cpfHash as string)) protegidosIds.add(c.clientId);
    }
  }

  let restaurados = 0;
  let protegidos = 0;
  let removidos = 0;
  let mantidos = 0;
  let ausentes = 0;
  const restoredClientIds: string[] = [];

  for (const c of changes) {
    try {
      if (c.kind === "ATUALIZADO" && c.before && protegidosIds.has(c.clientId)) {
        protegidos++;
      } else if (c.kind === "ATUALIZADO" && c.before) {
        await prisma.client.update({ where: { id: c.clientId }, data: reviveBefore(c.before as Record<string, unknown>) as any });
        restoredClientIds.push(c.clientId);
        restaurados++;
      } else if (c.kind === "CRIADO") {
        await prisma.accountSnapshot.deleteMany({ where: { tenantId, clientId: c.clientId, importJobId: { in: ids } } });
        await prisma.client.delete({ where: { id: c.clientId } });
        removidos++;
      }
    } catch (e: any) {
      // P2025: o cliente já não existe. Qualquer outro erro (ex.: cliente criado já tem compras/mensagens): mantém.
      if (e?.code === "P2025") ausentes++;
      else mantidos++;
    }
  }

  if (changes.length > 0) await prisma.importChange.deleteMany({ where: { id: { in: changes.map((c) => c.id) } } });
  if (restoredClientIds.length > 0) {
    await prisma.movement.deleteMany({ where: { clientId: { in: restoredClientIds }, tipo: "renovacao_limite", createdAt: { gte: inicio } } });
  }

  const restantes = await prisma.importChange.count({ where: { tenantId, importJobId: { in: ids } } });
  const concluido = restantes === 0;
  if (concluido) {
    await prisma.accountSnapshot.deleteMany({ where: { tenantId, importJobId: { in: ids } } });
    await prisma.importJob.updateMany({ where: { id: { in: ids }, tenantId }, data: { desfeitaEm: new Date(), desfeitaPor: userId } });
  }
  return { restaurados, protegidos, removidos, mantidos, ausentes, restantes, concluido };
}

export interface LoteRow {
  loteId: string;
  formato: string | null;
  nomeArquivo: string | null;
  source: string;
  status: string;
  startedAt: Date;
  totalRows: number;
  addedCount: number;
  updatedCount: number;
  errorCount: number;
  jobs: number;
  desfeita: boolean;
  desfeitaEm: Date | null;
}

/** Agrupa os jobs (uma requisição por lote de 400 linhas) em uma linha por arquivo. */
export function groupLotes(
  jobs: {
    id: string;
    loteId: string | null;
    formato: string | null;
    nomeArquivo: string | null;
    source: string;
    status: string;
    startedAt: Date;
    totalRows: number;
    addedCount: number;
    updatedCount: number;
    errorCount: number;
    desfeitaEm: Date | null;
  }[]
): LoteRow[] {
  const map = new Map<string, typeof jobs>();
  for (const j of jobs) {
    const key = j.loteId ?? j.id;
    map.set(key, [...(map.get(key) ?? []), j]);
  }
  const out: LoteRow[] = [];
  for (const [loteId, list] of map) {
    const first = [...list].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())[0];
    const statuses = list.map((j) => j.status);
    const status = statuses.includes("EM_EXECUCAO") ? "EM_EXECUCAO" : statuses.every((s) => s === "FALHOU") ? "FALHOU" : list.some((j) => j.errorCount > 0) ? "CONCLUIDO_COM_ERROS" : "CONCLUIDO";
    out.push({
      loteId,
      formato: first.formato,
      nomeArquivo: first.nomeArquivo,
      source: first.source,
      status,
      startedAt: first.startedAt,
      totalRows: list.reduce((a, j) => a + j.totalRows, 0),
      addedCount: list.reduce((a, j) => a + j.addedCount, 0),
      updatedCount: list.reduce((a, j) => a + j.updatedCount, 0),
      errorCount: list.reduce((a, j) => a + j.errorCount, 0),
      jobs: list.length,
      desfeita: list.every((j) => j.desfeitaEm),
      desfeitaEm: list.find((j) => j.desfeitaEm)?.desfeitaEm ?? null,
    });
  }
  return out.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
}

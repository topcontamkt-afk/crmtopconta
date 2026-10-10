import { AppPrismaClient } from "../config/db";

/**
 * Histórico de saldo/limite/status da conta (ver AccountSnapshot no schema). Chamado pela
 * importação de "Cartões e contas" com o estado anterior (o que estava em Client) e o novo.
 *
 * Grava uma linha quando: (a) saldo, limite ou status mudaram, ou (b) o cliente ainda não tem
 * nenhuma linha (cliente novo, ou existente desde antes desta tabela — a linha-base). Dia sem
 * mudança não grava nada: o estado numa data D é a última linha com recordedAt <= D.
 */

export interface AccountState {
  limiteTotal: number;
  saldoDisponivel: number;
  valorUtilizado: number;
  statusConta: "ATIVO" | "INATIVO" | "BLOQUEADO";
}

export interface SnapshotCandidate {
  clientId: string;
  /** estado que o Client tinha ANTES desta importação; undefined = cliente novo */
  previous?: Pick<AccountState, "limiteTotal" | "saldoDisponivel" | "statusConta">;
  current: AccountState;
}

const CHUNK = 500;

const cents = (n: number) => Math.round(n * 100);

/** true se algo que o histórico acompanha mudou (comparação em centavos, sem erro de float). */
export function hasAccountChanged(
  previous: SnapshotCandidate["previous"],
  current: AccountState
): boolean {
  if (!previous) return true;
  return (
    cents(previous.saldoDisponivel) !== cents(current.saldoDisponivel) ||
    cents(previous.limiteTotal) !== cents(current.limiteTotal) ||
    previous.statusConta !== current.statusConta
  );
}

/**
 * Grava as linhas de histórico do lote. Nunca lança: o histórico é auxiliar, e uma falha aqui
 * não pode derrubar a importação (o próximo lote/dia grava a linha-base de quem ficou sem).
 * Devolve quantas linhas foram gravadas.
 */
export async function recordAccountSnapshots(
  prisma: AppPrismaClient,
  tenantId: string,
  candidates: SnapshotCandidate[],
  importJobId: string,
  recordedAt: Date = new Date()
): Promise<number> {
  try {
    if (candidates.length === 0) return 0;

    // Mesmo cliente duas vezes no lote (documento repetido na planilha): fica uma linha só, a última.
    candidates = [...new Map(candidates.map((c) => [c.clientId, c])).values()];

    // Quem já tem alguma linha: os demais precisam da linha-base mesmo sem mudança de valor.
    const withHistory = new Set<string>();
    for (let i = 0; i < candidates.length; i += CHUNK) {
      const ids = candidates.slice(i, i + CHUNK).map((c) => c.clientId);
      const rows = await prisma.accountSnapshot.findMany({
        where: { tenantId, clientId: { in: ids } },
        select: { clientId: true },
        distinct: ["clientId"],
      });
      for (const r of rows) withHistory.add(r.clientId);
    }

    const toWrite = candidates.filter((c) => !withHistory.has(c.clientId) || hasAccountChanged(c.previous, c.current));

    let written = 0;
    for (let i = 0; i < toWrite.length; i += CHUNK) {
      const res = await prisma.accountSnapshot.createMany({
        data: toWrite.slice(i, i + CHUNK).map((c) => ({
          tenantId,
          clientId: c.clientId,
          recordedAt,
          limiteTotal: c.current.limiteTotal,
          saldoDisponivel: c.current.saldoDisponivel,
          saldoAnterior: c.previous ? c.previous.saldoDisponivel : null,
          valorUtilizado: c.current.valorUtilizado,
          statusConta: c.current.statusConta,
          importJobId,
        })),
      });
      written += res.count;
    }
    return written;
  } catch (e) {
    console.error("[accountSnapshot] falha ao gravar histórico (importação segue):", (e as Error).message);
    return 0;
  }
}

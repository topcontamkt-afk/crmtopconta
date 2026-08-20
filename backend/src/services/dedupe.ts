import { PrismaClient } from "@prisma/client";

/**
 * Deduplicação por CPF (hash) e telefone.
 * Regra de fusão: "última atualização ganha" — o registro recém-importado
 * sobrescreve campos do existente, preservando o histórico (Movement, MessageEvent)
 * e o id interno do cliente já cadastrado.
 */

export interface IncomingClientRow {
  externalId?: string;
  nome: string;
  telefone: string;
  cpfHash: string;
  cpfMasked: string;
  cidade?: string;
  dataCadastro?: Date;
  dataAberturaConta?: Date;
  limiteTotal: number;
  valorUtilizado: number;
  saldoDisponivel: number;
  valorAntecipado: number;
  dataUltimaUtilizacao?: Date;
  statusConta?: "ATIVO" | "INATIVO" | "BLOQUEADO";
  origemCliente?: string;
  autorizacaoComunicacao: boolean;
}

export async function findExistingClient(
  prisma: PrismaClient,
  tenantId: string,
  row: IncomingClientRow
) {
  // Prioridade 1: CPF (chave forte, única por tenant)
  const byCpf = await prisma.client.findUnique({
    where: { tenantId_cpfHash: { tenantId, cpfHash: row.cpfHash } },
  });
  if (byCpf) return byCpf;

  // Prioridade 2: telefone (fallback quando CPF não bate, ex.: erro de digitação em importações antigas)
  if (row.telefone) {
    const byPhone = await prisma.client.findFirst({
      where: { tenantId, telefone: row.telefone },
    });
    if (byPhone) return byPhone;
  }

  return null;
}

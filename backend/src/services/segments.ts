import { Prisma } from "@prisma/client";

/**
 * Definição de filtros de segmento (UI: filtros + preview count).
 * Suporta interseção (AND, default) das condições informadas.
 */
export interface SegmentFilters {
  cidade?: string[];
  faixaUso?: string[];
  statusConta?: string[];
  autorizacaoComunicacao?: boolean;
  semUsoDiasMin?: number; // dataUltimaUtilizacao mais antiga que N dias (ou nunca usou)
  tags?: string[];
  search?: string; // busca livre por nome/telefone
}

export function buildSegmentWhere(tenantId: string, filters: SegmentFilters): Prisma.ClientWhereInput {
  const where: Prisma.ClientWhereInput = { tenantId };

  if (filters.cidade?.length) where.cidade = { in: filters.cidade };
  if (filters.faixaUso?.length) where.faixaUso = { in: filters.faixaUso as any };
  if (filters.statusConta?.length) where.statusConta = { in: filters.statusConta as any };
  if (filters.autorizacaoComunicacao !== undefined) {
    where.autorizacaoComunicacao = filters.autorizacaoComunicacao;
  }
  if (filters.tags?.length) where.tags = { hasSome: filters.tags };
  if (filters.semUsoDiasMin !== undefined) {
    const cutoff = new Date(Date.now() - filters.semUsoDiasMin * 24 * 60 * 60 * 1000);
    where.OR = [{ dataUltimaUtilizacao: null }, { dataUltimaUtilizacao: { lte: cutoff } }];
  }
  if (filters.search) {
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
      {
        OR: [
          { nome: { contains: filters.search, mode: "insensitive" } },
          { telefone: { contains: filters.search } },
        ],
      },
    ];
  }

  return where;
}

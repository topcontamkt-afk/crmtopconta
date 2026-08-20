import { Prisma } from "@prisma/client";

/**
 * Definição de filtros de segmento (UI: filtros + preview count).
 */
export interface SegmentFilters {
  cidade?: string[];
  faixaUso?: string[];
  statusConta?: string[];
  autorizacaoComunicacao?: boolean;
  semUsoDiasMin?: number; // dataUltimaUtilizacao mais antiga que N dias (ou nunca usou) — "sem uso"/"inativo"
  usadoNosUltimosDias?: number; // dataUltimaUtilizacao dentro dos últimos N dias — "recorrente"/"ativo"
  tags?: string[];
  search?: string; // busca livre por nome/telefone
  clientIds?: string[]; // seleção explícita de clientes (usado pelo motor de automação)
}

/**
 * Segment builder avançado (Fase 2): grupos de condições combináveis com AND/OR,
 * permitindo expressões como "(cidade=SP E faixa=alto) OU (cidade=RJ E semUso>60)".
 * `conditions` é o grupo-folha (SegmentFilters combinados em AND entre si);
 * `groups` permite aninhar sub-expressões com seu próprio operador.
 */
export interface SegmentGroup {
  operator: "AND" | "OR";
  conditions?: SegmentFilters;
  groups?: SegmentGroup[];
}

function buildLeafWhere(tenantId: string, filters: SegmentFilters): Prisma.ClientWhereInput {
  const where: Prisma.ClientWhereInput = { tenantId };
  const and: Prisma.ClientWhereInput[] = [];

  if (filters.clientIds?.length) where.id = { in: filters.clientIds };
  if (filters.cidade?.length) where.cidade = { in: filters.cidade };
  if (filters.faixaUso?.length) where.faixaUso = { in: filters.faixaUso as any };
  if (filters.statusConta?.length) where.statusConta = { in: filters.statusConta as any };
  if (filters.autorizacaoComunicacao !== undefined) {
    where.autorizacaoComunicacao = filters.autorizacaoComunicacao;
  }
  if (filters.tags?.length) where.tags = { hasSome: filters.tags };
  if (filters.semUsoDiasMin !== undefined) {
    const cutoff = new Date(Date.now() - filters.semUsoDiasMin * 24 * 60 * 60 * 1000);
    and.push({ OR: [{ dataUltimaUtilizacao: null }, { dataUltimaUtilizacao: { lte: cutoff } }] });
  }
  if (filters.usadoNosUltimosDias !== undefined) {
    const cutoff = new Date(Date.now() - filters.usadoNosUltimosDias * 24 * 60 * 60 * 1000);
    and.push({ dataUltimaUtilizacao: { gte: cutoff } });
  }
  if (filters.search) {
    and.push({
      OR: [
        { nome: { contains: filters.search, mode: "insensitive" } },
        { telefone: { contains: filters.search } },
      ],
    });
  }
  if (and.length) where.AND = and;

  return where;
}

/** Constrói o `where` do Prisma recursivamente a partir de um SegmentGroup (AND/OR aninhados). */
export function buildGroupWhere(tenantId: string, group: SegmentGroup): Prisma.ClientWhereInput {
  const parts: Prisma.ClientWhereInput[] = [];

  if (group.conditions) parts.push(buildLeafWhere(tenantId, group.conditions));
  if (group.groups?.length) {
    for (const sub of group.groups) parts.push(buildGroupWhere(tenantId, sub));
  }

  if (parts.length === 0) return { tenantId };
  if (parts.length === 1) return parts[0];

  return group.operator === "OR" ? { tenantId, OR: parts } : { tenantId, AND: parts };
}

/**
 * Compatibilidade retroativa: aceita tanto o formato simples (SegmentFilters "flat") usado
 * pelo wizard de campanhas quanto o formato avançado com grupos ({operator, conditions, groups}).
 */
export function buildSegmentWhere(
  tenantId: string,
  filtersOrGroup: SegmentFilters | SegmentGroup | undefined | null
): Prisma.ClientWhereInput {
  if (!filtersOrGroup) return { tenantId };
  if ("operator" in filtersOrGroup && (filtersOrGroup.conditions || filtersOrGroup.groups)) {
    return buildGroupWhere(tenantId, filtersOrGroup as SegmentGroup);
  }
  return buildLeafWhere(tenantId, filtersOrGroup as SegmentFilters);
}

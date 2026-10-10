import { Prisma } from "@prisma/client";
import { limiteRange, LIMITE_TETO, PerfilRenda } from "./rendaPerfil";

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
  contaEncerrada?: boolean; // conta encerrada (encerradoEm preenchido) ou statusConta=INATIVO
  tags?: string[];
  search?: string; // busca livre por nome/telefone
  clientIds?: string[]; // seleção explícita de clientes (usado pelo motor de automação e por
  // públicos pré-montados no Dashboard, ex.: aniversariantes do mês)
  empresaConveniada?: string[]; // convênio/secretaria de vínculo (só populado no formato "Cartões e contas"/"SaldoCartao")
  // Comércio credenciado (aba "Todas as Compras"): clientes que compraram em lojistas de certas
  // categorias (ex.: SUPERMERCADO, POSTO) e/ou em lojistas específicos, opcionalmente dentro de uma
  // janela de dias. Sem categoria nem lojista, `compraNosUltimosDias` vale para qualquer compra no
  // comércio credenciado.
  categoriasCompra?: string[];
  lojistaIds?: string[];
  compraNosUltimosDias?: number;
  // Perfil de renda PF1–PF4, estimado pelo limite (limite ÷ 0,40) — ver services/rendaPerfil.ts.
  // Vários perfis se combinam em OR. Clientes sem limite (comércio credenciado) não têm perfil.
  perfilRenda?: PerfilRenda[];
  // Limite exatamente no teto de R$ 2.000 (renda real de R$ 5.000 ou mais, sem separar).
  noTetoLimite?: boolean;
  // Saldo disponível mínimo (R$): "com saldo" = podia usar no momento.
  saldoDisponivelMin?: number;
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
  if (filters.empresaConveniada?.length) where.empresaConveniada = { in: filters.empresaConveniada };
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
  if (filters.contaEncerrada) {
    and.push({ OR: [{ encerradoEm: { not: null } }, { statusConta: "INATIVO" }] });
  }
  if (filters.usadoNosUltimosDias !== undefined) {
    const cutoff = new Date(Date.now() - filters.usadoNosUltimosDias * 24 * 60 * 60 * 1000);
    and.push({ dataUltimaUtilizacao: { gte: cutoff } });
  }
  if (filters.categoriasCompra?.length || filters.lojistaIds?.length || filters.compraNosUltimosDias !== undefined) {
    const purchase: Prisma.PurchaseWhereInput = { tenantId };
    if (filters.categoriasCompra?.length) purchase.merchant = { category: { in: filters.categoriasCompra } };
    if (filters.lojistaIds?.length) purchase.merchantId = { in: filters.lojistaIds };
    if (!filters.categoriasCompra?.length && !filters.lojistaIds?.length) purchase.merchantId = { not: null };
    if (filters.compraNosUltimosDias !== undefined) {
      purchase.occurredAt = { gte: new Date(Date.now() - filters.compraNosUltimosDias * 24 * 60 * 60 * 1000) };
    }
    and.push({ purchases: { some: purchase } });
  }
  if (filters.perfilRenda?.length) {
    and.push({
      OR: filters.perfilRenda.map((p) => {
        const r = limiteRange(p);
        return { limiteTotal: r.lte === undefined ? { gt: r.gt } : { gt: r.gt, lte: r.lte } };
      }),
    });
  }
  if (filters.noTetoLimite) and.push({ limiteTotal: LIMITE_TETO });
  if (filters.saldoDisponivelMin !== undefined) and.push({ saldoDisponivel: { gte: filters.saldoDisponivelMin } });
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

/** Público "Inativos": conta encerrada/inativa OU mais de 90 dias sem uso (grupos combinados em OR). */
export const INATIVOS_SEGMENT_NAME = "Inativos";
export const INATIVOS_SEMUSO_DIAS = 90;
export const INATIVOS_FILTERS: SegmentGroup = {
  operator: "OR",
  groups: [
    { operator: "AND", conditions: { contaEncerrada: true } },
    { operator: "AND", conditions: { semUsoDiasMin: INATIVOS_SEMUSO_DIAS } },
  ],
};

/**
 * Quem pode receber disparo de consumidor: tem limite. Cliente sem limite (zero) é comércio
 * credenciado — está na base como cadastro, mas não é público de campanha de cartão. Aplicado na
 * montagem do público (campaignQueue.buildAudience), na estimativa do assistente e, por garantia,
 * no envio da fila.
 */
export const ENVIAVEL_WHERE: Prisma.ClientWhereInput = { limiteTotal: { gt: 0 } };

/** Saldo disponível mínimo (R$) para considerar que o cliente "tem saldo" (podia usar). */
export const SALDO_MINIMO_ELEGIVEL = 10;

export interface SegmentPreset {
  name: string;
  filters: SegmentFilters;
}

/**
 * Segmentos prontos de perfil de renda × uso. Criados de uma vez por
 * POST /api/segments/presets/perfis-renda (idempotente: o mesmo nome só é recontado).
 * "Sem uso no momento" = limite todo disponível hoje; NÃO prova que nunca usou (quem usou e já teve
 * a fatura descontada em folha também fica com o limite cheio). Só o histórico de compras separa.
 */
export const PERFIL_RENDA_PRESETS: SegmentPreset[] = [
  { name: "PF1 · base geral", filters: { perfilRenda: ["PF1"] } },
  { name: "PF1 · sem uso no momento", filters: { perfilRenda: ["PF1"], faixaUso: ["SEM_USO"] } },
  { name: "PF1 · com saldo", filters: { perfilRenda: ["PF1"], saldoDisponivelMin: SALDO_MINIMO_ELEGIVEL } },
  { name: "PF1 · limite 100% usado", filters: { perfilRenda: ["PF1"], faixaUso: ["USO_100"] } },
  { name: "PF2 · base geral", filters: { perfilRenda: ["PF2"] } },
  { name: "PF2 · sem uso no momento", filters: { perfilRenda: ["PF2"], faixaUso: ["SEM_USO"] } },
  { name: "PF2 · com saldo", filters: { perfilRenda: ["PF2"], saldoDisponivelMin: SALDO_MINIMO_ELEGIVEL } },
  { name: "PF2 · limite 100% usado", filters: { perfilRenda: ["PF2"], faixaUso: ["USO_100"] } },
  { name: "PF2+ · no teto de R$ 2.000", filters: { noTetoLimite: true } },
  { name: "PF3 · base geral", filters: { perfilRenda: ["PF3"] } },
  { name: "PF4 · base geral", filters: { perfilRenda: ["PF4"] } },
];

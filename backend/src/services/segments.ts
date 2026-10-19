import { etapaWhere, EtapaUso } from "./etapaUso";
import { Prisma } from "../generated/prisma/client";
import { PerfilRenda } from "./rendaPerfil";
import { diasAberturaNaFaixa, FaixaDias } from "./ciclos";

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
  /**
   * @deprecated LGPD 01-03 (triagem, decisão 2): renda é só estatística agregada (dashboard), não filtro de
   * público. Segmentos salvos antes ainda trazem o campo: ele é IGNORADO no cálculo e a tela avisa
   * (`filtrosRendaIgnorados`).
   */
  perfilRenda?: PerfilRenda[];
  /** @deprecated LGPD 01-03: "no teto do limite" = renda de R$ 5.000 ou mais; ignorado como `perfilRenda`. */
  noTetoLimite?: boolean;
  // Saldo disponível mínimo (R$): "com saldo" = podia usar no momento.
  saldoDisponivelMin?: number;
  etapaUso?: EtapaUso[]; // etapa pelo extrato (ver etapaUso.ts)
  usosMin?: number; // mínimo de usos reais nos últimos 90 dias
  usosMax?: number; // máximo de usos reais nos últimos 90 dias
  diasSemUsoRealMin?: number; // último uso real há pelo menos N dias (ou nunca usou)
  diasSemUsoRealMax?: number; // último uso real há no máximo N dias
  // Ciclo da cidade (limite renova na abertura; ver ciclos.ts): "abriu há 0–3 dias" / "abre em 1–5 dias".
  // Clientes de cidade sem ciclo cadastrado não entram em nenhum dos dois.
  cicloAbriuHaDias?: FaixaDias;
  cicloAbreEmDias?: FaixaDias;
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
  if (filters.tags?.length) where.tags = { some: { tag: { in: filters.tags } } };
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
  // LGPD 01-03: perfilRenda e noTetoLimite não filtram mais (ver FILTROS_RENDA)
  if (filters.saldoDisponivelMin !== undefined) and.push({ saldoDisponivel: { gte: filters.saldoDisponivelMin } });
  if (filters.etapaUso?.length) and.push({ OR: filters.etapaUso.map((e) => etapaWhere(e)) });
  if (filters.usosMin !== undefined) and.push({ usosUltimos90d: { gte: filters.usosMin } });
  if (filters.usosMax !== undefined) and.push({ usosUltimos90d: { lte: filters.usosMax } });
  if (filters.diasSemUsoRealMin !== undefined) {
    const cutoff = new Date(Date.now() - filters.diasSemUsoRealMin * 86400000);
    and.push({ OR: [{ ultimoUsoReal: null }, { ultimoUsoReal: { lte: cutoff } }] });
  }
  if (filters.diasSemUsoRealMax !== undefined) {
    and.push({ ultimoUsoReal: { gte: new Date(Date.now() - filters.diasSemUsoRealMax * 86400000) } });
  }
  if (filters.cicloAbriuHaDias) and.push({ diaCicloAbertura: { in: diasAberturaNaFaixa(filters.cicloAbriuHaDias, "abriuHa") } });
  if (filters.cicloAbreEmDias) and.push({ diaCicloAbertura: { in: diasAberturaNaFaixa(filters.cicloAbreEmDias, "abreEm") } });
  if (filters.search) {
    and.push({
      OR: [
        // SQLite: `contains` vira LIKE, que já ignora maiúscula/minúscula só em ASCII ("joão" não acha
        // "JOÃO"). A busca sem acento e sem caixa entra com a coluna `nomeBusca` (Fase 4 da migração).
        { nome: { contains: filters.search } },
        { telefone: { contains: filters.search } },
      ],
    });
  }
  if (and.length) where.AND = and;

  return where;
}

/** LGPD 01-03: filtros de renda que deixaram de valer para público (ficam só na estatística do dashboard). */
export const FILTROS_RENDA = ["perfilRenda", "noTetoLimite"] as const;

/**
 * Segmento ou regra antiga com filtro de renda: sem o filtro, o público ficaria MAIOR do que o planejado (ex.: "PF1
 * com saldo" viraria "todos com saldo"), então campanha e automação com ele não saem até a pessoa revisar.
 */
export const AVISO_RENDA_IGNORADA =
  "O público usa filtro de perfil de renda, que deixou de valer (LGPD). Sem ele, a mensagem iria para mais gente do que o planejado. Edite o segmento ou a regra e escolha outro critério.";

/**
 * Filtros de renda presentes (e ignorados) num segmento salvo, em qualquer nível de grupo. Lista vazia = nada
 * ignorado. Usado para a tela avisar que o segmento antigo passou a contar sem o filtro de renda.
 */
export function filtrosRendaIgnorados(filtersOrGroup: unknown): string[] {
  const achados = new Set<string>();
  const visitar = (f: any) => {
    if (!f || typeof f !== "object") return;
    for (const k of FILTROS_RENDA) {
      const v = f[k];
      if (v !== undefined && v !== null && v !== false && !(Array.isArray(v) && v.length === 0)) achados.add(k);
    }
    if (f.conditions) visitar(f.conditions);
    if (Array.isArray(f.groups)) f.groups.forEach(visitar);
  };
  visitar(filtersOrGroup);
  return [...achados];
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
 * no envio da fila. LGPD 03-04: nem cliente com o tratamento suspenso a pedido do titular
 * (`bloqueadoLgpdAt`), em todo lugar que monta ou conta público (ciclos, comércio, dashboard).
 * O `buildSegmentWhere` não exclui o bloqueio por conta própria: a listagem de clientes usa o mesmo
 * builder e mostra bloqueados quando pedido (routes/clients.ts aplicarBloqueio).
 */
// LGPD 03-04 / 04-06 / 04-01: suspenso a pedido, conta encerrada (sai de todo uso comercial, decisão 4 da triagem) e
// cliente anonimizado nunca entram em público de envio. Só chaves de topo que nenhum filtro de segmento usa no topo:
// o filtro `contaEncerrada` fica dentro de AND, então um segmento de encerrados simplesmente não tem quem receber.
export const ENVIAVEL_WHERE: Prisma.ClientWhereInput = { limiteTotal: { gt: 0 }, bloqueadoLgpdAt: null, encerradoEm: null, anonymizedAt: null };

/** Saldo disponível mínimo (R$) para considerar que o cliente "tem saldo" (podia usar). */
export const SALDO_MINIMO_ELEGIVEL = 10;

export interface SegmentPreset {
  name: string;
  filters: SegmentFilters;
}

// LGPD 01-03: os segmentos prontos de perfil de renda (PF1–PF4 × uso, antigo PERFIL_RENDA_PRESETS) foram
// retirados: renda não é mais critério de público. O card de perfis do dashboard continua (agregado).

/** Segmentos prontos por etapa de uso real. */
export const ETAPA_USO_PRESETS: SegmentPreset[] = [
  { name: "Etapa · nunca usou", filters: { etapaUso: ["NUNCA_USOU"] } },
  { name: "Etapa · recorrentes", filters: { etapaUso: ["RECORRENTE"] } },
  { name: "Etapa · ocasionais", filters: { etapaUso: ["OCASIONAL"] } },
  { name: "Etapa · em risco (31–90 dias sem uso)", filters: { etapaUso: ["EM_RISCO"] } },
  { name: "Etapa · inativos (+90 dias sem uso)", filters: { etapaUso: ["INATIVO"] } },
];

import { Prisma } from "@prisma/client";
import { AppPrismaClient, tenantRaw } from "../config/db";
import { addDays, clientWhere, DashboardFilters, rawFilterSql } from "./dashboardMetrics";

/**
 * Fila de oportunidades do dashboard: públicos prontos para campanha, calculados sobre dados reais.
 * Cada oportunidade vira `campanha` (tem público e mensagem), `dados` (falta dado na origem: o
 * motivo é mostrado, não é campanha) ou `historico` (depende de histórico/transações que ainda não
 * existem). Textos de mensagem só usam variáveis que o envio realmente suporta
 * (TEMPLATE_VARIABLES em campaignQueue.ts) — há teste garantindo isso.
 */

export type OpportunityKey =
  | "inativos"
  | "semUso"
  | "uso_1_49"
  | "uso_50_69"
  | "uso_70_79"
  | "uso_80_99"
  | "uso_100"
  | "ativosComSaldo"
  | "novos30d"
  | "aniversariantes"
  | "comercio_super_sem_posto"
  | "comercio_1vez"
  | "comercio_3mais"
  | "comercio_top10"
  | "quaseCompleto"; // legado (faixa QUASE_COMPLETO); mantido para compatibilidade com /audiencia

export const OPPORTUNITY_KEYS: OpportunityKey[] = [
  "inativos", "semUso", "uso_1_49", "uso_50_69", "uso_70_79", "uso_80_99", "uso_100",
  "ativosComSaldo", "novos30d", "aniversariantes",
  "comercio_super_sem_posto", "comercio_1vez", "comercio_3mais", "comercio_top10", "quaseCompleto",
];

/** Faixas do módulo "uso do limite" (cortes 50/70/80%). A faixa 0% é a própria oportunidade `semUso`. */
export interface BandDef {
  key: OpportunityKey | "uso_0";
  range: string;
  label: string;
  titulo: string;
  acao: string;
  mensagem: string;
  cor: string;
}

export const USO_BANDAS: BandDef[] = [
  {
    key: "uso_0", range: "0%", label: "Sem uso", titulo: "Sem uso (0%)", cor: "#f59e0b",
    acao: "Ativação: o cartão está liberado e nunca foi usado. Mostrar onde usar (comércio credenciado) e quanto há de limite.",
    mensagem: "Olá, {{nome}}! Seu limite de {{limite}} no cartão TopConta está liberado. Use nos parceiros credenciados perto de você.",
  },
  {
    key: "uso_1_49", range: "1 a 49%", label: "Uso inicial", titulo: "Uso inicial (1 a 49%)", cor: "#5b8cff",
    acao: "Incentivo: já usou, mas pouco. Reforçar os parceiros e a vantagem de usar o cartão no dia a dia.",
    mensagem: "Olá, {{nome}}! Você já tem {{saldo}} disponíveis no cartão TopConta. Que tal usar nas compras desta semana?",
  },
  {
    key: "uso_50_69", range: "50 a 69%", label: "Uso intermediário", titulo: "Uso intermediário (50 a 69%)", cor: "#2dd4bf",
    acao: "Consolidação: cliente engajado. Reforçar os parceiros que ele já frequenta e acompanhar o saldo.",
    mensagem: "Olá, {{nome}}! Seu cartão TopConta está rendendo: você usou {{percentual}}% do limite e ainda tem {{saldo}} para o mês.",
  },
  {
    key: "uso_70_79", range: "70 a 79%", label: "Uso alto", titulo: "Uso alto (70 a 79%)", cor: "#a78bfa",
    acao: "Atenção: avisar do saldo restante antes de esgotar e oferecer acompanhamento do limite.",
    mensagem: "Olá, {{nome}}! Restam {{saldo}} do seu limite no cartão TopConta. Use com tranquilidade e acompanhe seu saldo.",
  },
  {
    key: "uso_80_99", range: "80 a 99%", label: "Quase no limite", titulo: "Quase no limite (80 a 99%)", cor: "#ff6907",
    acao: "Pré-renovação: avisar o saldo restante e abrir o pedido de aumento de limite antes de esgotar.",
    mensagem: "Olá, {{nome}}! Seu limite está quase no fim ({{percentual}}% usado). Quer pedir um aumento? É só responder esta mensagem.",
  },
  {
    key: "uso_100", range: "100%", label: "Limite esgotado", titulo: "Limite esgotado (100%)", cor: "#f0616d",
    acao: "Maior potencial de valor: o cliente usa tudo o que tem. Oferecer aumento de limite ou nova renovação.",
    mensagem: "Olá, {{nome}}! Você usou todo o limite do cartão TopConta. Podemos analisar um aumento para você: responda esta mensagem.",
  },
];

/** `where` de cada faixa de uso (sem a faixa 0%, que usa faixaUso = NAO_UTILIZOU como `semUso`). */
export function bandWhere(key: OpportunityKey): Prisma.ClientWhereInput | null {
  switch (key) {
    case "uso_1_49": return { percentualUtilizado: { gt: 0, lt: 50 } };
    case "uso_50_69": return { percentualUtilizado: { gte: 50, lt: 70 } };
    case "uso_70_79": return { percentualUtilizado: { gte: 70, lt: 80 } };
    case "uso_80_99": return { percentualUtilizado: { gte: 80, lt: 100 } };
    case "uso_100": return { percentualUtilizado: { gte: 100 } };
    default: return null;
  }
}

type Impacto = "Alto" | "Médio" | "Baixo";
type Status = "campanha" | "dados" | "historico";

interface OppDef {
  key: string;
  grupo: string;
  titulo: string;
  desc: string;
  impacto: Impacto;
  status: Status;
  mensagem?: string;
  destino?: string; // para status "dados": onde corrigir
  destinoLabel?: string;
  motivo?: string; // para status "historico"
}

export const OPORTUNIDADES: OppDef[] = [
  { key: "inativos", grupo: "Ativação", titulo: "Clientes inativos", desc: "Conta inativa: reengajamento é a maior alavanca de crescimento.", impacto: "Alto", status: "campanha",
    mensagem: "Olá, {{nome}}! Sentimos sua falta. Seu cartão TopConta continua à disposição: use nos parceiros credenciados." },
  { key: "semUso", grupo: "Ativação", titulo: "Nunca utilizaram o cartão", desc: "Têm limite liberado e não usaram. Campanha de primeira compra.", impacto: "Alto", status: "campanha",
    mensagem: USO_BANDAS[0].mensagem },
  { key: "uso_100", grupo: "Uso do limite", titulo: "Limite esgotado (100%)", desc: "Usam tudo o que têm: oferecer aumento de limite.", impacto: "Alto", status: "campanha", mensagem: USO_BANDAS[5].mensagem },
  { key: "uso_80_99", grupo: "Uso do limite", titulo: "Quase no limite (80 a 99%)", desc: "Avisar o saldo e abrir pedido de aumento antes de esgotar.", impacto: "Médio", status: "campanha", mensagem: USO_BANDAS[4].mensagem },
  { key: "comercio_super_sem_posto", grupo: "Comércio", titulo: "Compram em supermercado e nunca em posto", desc: "Venda cruzada: apresentar os postos credenciados.", impacto: "Médio", status: "campanha",
    mensagem: "Olá, {{nome}}! Você já usa o cartão TopConta no supermercado. Sabia que também vale nos postos credenciados? Abasteça com seu limite." },
  { key: "comercio_1vez", grupo: "Comércio", titulo: "Compraram uma única vez", desc: "Voltar a comprar: lembrar dos parceiros e do saldo.", impacto: "Médio", status: "campanha",
    mensagem: "Olá, {{nome}}! Você ainda tem {{saldo}} no cartão TopConta. Volte a comprar nos parceiros credenciados." },
  { key: "comercio_3mais", grupo: "Comércio", titulo: "Compram 3 vezes ou mais", desc: "Clientes fiéis: programa de fidelidade ou benefício exclusivo.", impacto: "Médio", status: "campanha",
    mensagem: "Olá, {{nome}}! Obrigado por usar o cartão TopConta com frequência. Em breve teremos novidades para você." },
  { key: "comercio_top10", grupo: "Comércio", titulo: "Top 10% em valor comprado", desc: "Os clientes que mais compram: atendimento prioritário.", impacto: "Alto", status: "campanha",
    mensagem: "Olá, {{nome}}! Você é um dos nossos melhores clientes no cartão TopConta. Fale com a gente para condições especiais." },
  { key: "aniversariantes", grupo: "Relacionamento", titulo: "Aniversariantes do mês", desc: "Mensagem de relacionamento com o cartão no centro.", impacto: "Baixo", status: "campanha",
    mensagem: "Olá, {{nome}}! A equipe TopConta deseja um feliz aniversário! Aproveite seu mês." },
  { key: "ativosComSaldo", grupo: "Relacionamento", titulo: "Ativos com saldo disponível", desc: "Já usam e ainda têm limite: lembrar de usar.", impacto: "Médio", status: "campanha",
    mensagem: "Olá, {{nome}}! Você ainda tem {{saldo}} disponíveis no cartão TopConta. Aproveite nos parceiros credenciados." },
  { key: "novos30d", grupo: "Relacionamento", titulo: "Novos clientes (últimos 30 dias)", desc: "Boas-vindas com o passo a passo de uso.", impacto: "Médio", status: "campanha",
    mensagem: "Olá, {{nome}}! Bem-vindo ao cartão TopConta. Seu limite de {{limite}} já está liberado: veja onde usar." },
  { key: "semLimite", grupo: "Qualidade dos dados", titulo: "Sem limite cadastrado", desc: "Distorce todos os cálculos de uso. Não é campanha: revisar a coluna de limite na planilha.", impacto: "Alto", status: "dados", destino: "/clients?faixaUso=INDEFINIDO", destinoLabel: "Ver clientes" },
  { key: "validadePassada", grupo: "Qualidade dos dados", titulo: "Validade do cartão no passado", desc: "Se quase todos aparecem vencidos, provavelmente é a coluna errada. Conferir antes de usar “cartão vencendo”.", impacto: "Médio", status: "dados", destino: "/imports", destinoLabel: "Conferir importação" },
  { key: "semCidade", grupo: "Qualidade dos dados", titulo: "Sem cidade", desc: "Sem a coluna de cidade não há ranking nem campanha por cidade.", impacto: "Médio", status: "dados", destino: "/imports", destinoLabel: "Importar planilha" },
  { key: "h_queda", grupo: "Depende de histórico", titulo: "Queda de uso contra o mês anterior", desc: "Compara o uso de um mês com o anterior.", impacto: "Alto", status: "historico", motivo: "Precisa do histórico diário (já está sendo gravado) e de transações." },
  { key: "h_parou", grupo: "Depende de histórico", titulo: "Parou de comprar (sem compra há 30 dias)", desc: "Clientes que compravam e sumiram.", impacto: "Alto", status: "historico", motivo: "Precisa de compras recentes importadas." },
  { key: "h_renovado", grupo: "Depende de histórico", titulo: "Limite renovado recentemente", desc: "Detectado na importação quando o limite sobe.", impacto: "Médio", status: "historico", motivo: "Aparece quando uma importação registrar aumento de limite." },
  { key: "h_churn", grupo: "Depende de histórico", titulo: "Risco de cancelamento", desc: "Previsão por queda de uso.", impacto: "Alto", status: "historico", motivo: "Precisa de meses de histórico e dos encerramentos." },
];

export interface Buyer {
  id: string;
  n: number;
  valor: number;
  super: boolean;
  posto: boolean;
}

/** Quem comprou no comércio credenciado, com o necessário para os cortes de comércio. */
async function loadBuyers(tenantId: string, filters: DashboardFilters): Promise<Buyer[]> {
  const raw = rawFilterSql(filters, 2, "c");
  const rows = await tenantRaw.query<Array<{ id: string; n: number; valor: number; super: boolean; posto: boolean }>>(
    `SELECT p."clientId" AS id, COUNT(*)::int AS n, COALESCE(SUM(p."valorPrincipal"), 0)::float AS valor,
            BOOL_OR(m."category" = 'SUPERMERCADO') AS super, BOOL_OR(m."category" = 'POSTO') AS posto
     FROM "Purchase" p
     JOIN "Merchant" m ON m."id" = p."merchantId"
     JOIN "Client" c ON c."id" = p."clientId"
     WHERE p."tenantId" = $1 ${raw.sql}
     GROUP BY p."clientId"`,
    tenantId,
    ...raw.params
  );
  return rows;
}

/** Cortes de comércio sobre a lista de compradores (função pura, testada). */
export function commerceCohorts(buyers: Buyer[]): Record<"comercio_super_sem_posto" | "comercio_1vez" | "comercio_3mais" | "comercio_top10", string[]> {
  const topN = Math.floor(buyers.length * 0.1);
  const top10 = [...buyers].sort((a, b) => b.valor - a.valor).slice(0, topN);
  return {
    comercio_super_sem_posto: buyers.filter((b) => b.super && !b.posto).map((b) => b.id),
    comercio_1vez: buyers.filter((b) => b.n === 1).map((b) => b.id),
    comercio_3mais: buyers.filter((b) => b.n >= 3).map((b) => b.id),
    comercio_top10: top10.map((b) => b.id),
  };
}

const MONTH_BRT = `EXTRACT(MONTH FROM (now() AT TIME ZONE 'America/Sao_Paulo'))`;

/** Resultado de `computeOpportunities`. */
export async function computeOpportunities(prisma: AppPrismaClient, tenantId: string, filters: DashboardFilters = {}) {
  const base = clientWhere(tenantId, filters);
  const and = (extra: Prisma.ClientWhereInput) => ({ AND: [base, extra] });
  const raw = rawFilterSql(filters, 2);
  const since30 = addDays(new Date(), -30);

  const [
    total, inativos, semUso, uso1, uso2, uso3, uso4, uso5, comSaldo, novos, semLimite, semCidade, validade,
    aniversariantes, buyers, anyPurchase,
  ] = await Promise.all([
    prisma.client.count({ where: base }),
    prisma.client.count({ where: and({ statusConta: "INATIVO" }) }),
    prisma.client.count({ where: and({ faixaUso: "NAO_UTILIZOU" }) }),
    prisma.client.count({ where: and(bandWhere("uso_1_49")!) }),
    prisma.client.count({ where: and(bandWhere("uso_50_69")!) }),
    prisma.client.count({ where: and(bandWhere("uso_70_79")!) }),
    prisma.client.count({ where: and(bandWhere("uso_80_99")!) }),
    prisma.client.count({ where: and(bandWhere("uso_100")!) }),
    prisma.client.count({ where: and({ statusConta: "ATIVO", saldoDisponivel: { gt: 0 } }) }),
    prisma.client.count({ where: and({ createdAt: { gte: since30 } }) }),
    prisma.client.count({ where: and({ limiteTotal: { lte: 0 } }) }),
    prisma.client.count({ where: and({ cidade: null }) }),
    prisma.client.count({ where: and({ dataValidadeCartao: { lt: new Date() } }) }),
    tenantRaw.query<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM "Client"
       WHERE "tenantId" = $1 AND "dataNascimento" IS NOT NULL AND EXTRACT(MONTH FROM "dataNascimento") = ${MONTH_BRT} ${raw.sql}`,
      tenantId,
      ...raw.params
    ),
    loadBuyers(tenantId, filters),
    prisma.purchase.count({ where: { tenantId } }),
  ]);

  const cohorts = commerceCohorts(buyers);
  const counts: Record<string, number> = {
    inativos, semUso,
    uso_0: semUso, uso_1_49: uso1, uso_50_69: uso2, uso_70_79: uso3, uso_80_99: uso4, uso_100: uso5,
    ativosComSaldo: comSaldo, novos30d: novos,
    aniversariantes: Number(aniversariantes[0]?.count ?? 0),
    semLimite, semCidade, validadePassada: validade,
    comercio_super_sem_posto: cohorts.comercio_super_sem_posto.length,
    comercio_1vez: cohorts.comercio_1vez.length,
    comercio_3mais: cohorts.comercio_3mais.length,
    comercio_top10: cohorts.comercio_top10.length,
  };

  const comLimite = uso1 + uso2 + uso3 + uso4 + uso5 + semUso;
  const faixas = USO_BANDAS.map((b) => ({ ...b, n: counts[b.key] ?? 0 }));

  const itens = OPORTUNIDADES.map((o) => {
    const isCommerce = o.key.startsWith("comercio_");
    let status: Status | "zero" = o.status;
    let destino = o.destino;
    let destinoLabel = o.destinoLabel;
    let desc = o.desc;
    if (isCommerce && anyPurchase === 0) {
      status = "dados";
      destino = "/imports";
      destinoLabel = "Importar compras";
      desc = "Importe a aba “Todas as Compras” (formato Compras) para liberar este público.";
    } else if (status === "campanha" && (counts[o.key] ?? 0) === 0) {
      status = "zero";
    }
    return { ...o, desc, status, destino, destinoLabel, n: o.status === "historico" ? null : counts[o.key] ?? 0 };
  });

  return { totalClientes: total, comLimite, cortes: [50, 70, 80], faixas, itens };
}

/** Ids do público de uma oportunidade (limitado a 5000, como o restante do fluxo de campanha). */
export async function opportunityAudience(
  prisma: AppPrismaClient,
  tenantId: string,
  filters: DashboardFilters,
  key: OpportunityKey
): Promise<string[]> {
  const base = clientWhere(tenantId, filters);
  const ids = async (extra: Prisma.ClientWhereInput) =>
    (await prisma.client.findMany({ where: { AND: [base, extra] }, select: { id: true }, take: 5000 })).map((c) => c.id);

  switch (key) {
    case "inativos": return ids({ statusConta: "INATIVO" });
    case "semUso": return ids({ faixaUso: "NAO_UTILIZOU" });
    case "quaseCompleto": return ids({ faixaUso: "QUASE_COMPLETO" });
    case "ativosComSaldo": return ids({ statusConta: "ATIVO", saldoDisponivel: { gt: 0 } });
    case "novos30d": return ids({ createdAt: { gte: addDays(new Date(), -30) } });
    case "uso_1_49": case "uso_50_69": case "uso_70_79": case "uso_80_99": case "uso_100":
      return ids(bandWhere(key)!);
    case "aniversariantes": {
      const raw = rawFilterSql(filters, 2);
      const rows = await tenantRaw.query<Array<{ id: string }>>(
        `SELECT "id" FROM "Client" WHERE "tenantId" = $1 AND "dataNascimento" IS NOT NULL
           AND EXTRACT(MONTH FROM "dataNascimento") = ${MONTH_BRT} ${raw.sql} LIMIT 5000`,
        tenantId,
        ...raw.params
      );
      return rows.map((r) => r.id);
    }
    case "comercio_super_sem_posto": case "comercio_1vez": case "comercio_3mais": case "comercio_top10":
      return commerceCohorts(await loadBuyers(tenantId, filters))[key].slice(0, 5000);
  }
}

/** Mensagem sugerida de uma oportunidade (para pré-preencher o assistente de campanha). */
export function suggestedMessage(key: OpportunityKey): string | undefined {
  if (key === "quaseCompleto") return USO_BANDAS[4].mensagem;
  const band = USO_BANDAS.find((b) => b.key === key);
  if (band) return band.mensagem;
  return OPORTUNIDADES.find((o) => o.key === key)?.mensagem;
}

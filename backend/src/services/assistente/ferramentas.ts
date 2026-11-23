import { z } from "zod";
import { prisma } from "../../config/db";
import { addDays, computeKpis, todayBrt } from "../dashboardMetrics";
import { buildSegmentWhere, SegmentFilters } from "../segments";
import { buildMelhorouCaiu } from "../insights";
import { dadosCidadesDesempenho, dadosHorarios, dadosOportunidades } from "../../routes/dashboard";
import { dadosConvenios, dadosFinanceiro, dadosFontes } from "../../routes/negocio";
import { adaptarCidades, adaptarConvenios, adaptarFinanceiro, adaptarHorarios, adaptarOportunidades, sanitizar } from "./adaptadores";

/**
 * Catálogo de ferramentas do assistente. Regras que valem para TODAS (testadas em ferramentas.test.ts):
 *  - só leitura: nenhuma grava, envia ou altera nada;
 *  - só dados reais do sistema: nada de projeção, previsão ou estimativa (ver adaptadores.ts);
 *  - nada de dado pessoal de cliente: só contagens, somas e médias; listas ficam na tela do sistema (`linkLista`);
 *  - sempre no tenant de quem pergunta (o `tenantId` vem do login, nunca do modelo).
 */

export type AreaFerramenta = "dashboard" | "clients" | "campaigns";

export interface ContextoFerramenta {
  tenantId: string;
  userId: string;
  role: string;
  /** Acesso por área do usuário (quando o sistema tem esse controle). Sem a função, tudo liberado pelo papel. */
  podeUsar?: (area: AreaFerramenta) => boolean;
}

export interface Ferramenta {
  nome: string;
  descricao: string;
  area: AreaFerramenta;
  somenteLeitura: true;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
  entrada: z.ZodType<any>;
  executar: (ctx: ContextoFerramenta, entrada: any) => Promise<unknown>;
}

const texto = z.string().trim().min(1).max(120);
const filtroCidadeConvenio = z.object({ cidade: texto.optional(), convenio: texto.optional() }).strict();

const STATUS = ["ATIVO", "INATIVO", "BLOQUEADO"] as const;
const FAIXAS = ["SEM_USO", "USO_1_10", "USO_11_20", "USO_21_30", "USO_31_50", "USO_51_70", "USO_71_99", "USO_100", "INDEFINIDO"] as const;
const ETAPAS = ["NUNCA_USOU", "RECORRENTE", "OCASIONAL", "EM_RISCO", "INATIVO"] as const;
const PERFIS = ["PF1", "PF2", "PF3", "PF4"] as const;
const AGRUPAR = ["cidade", "statusConta", "faixaUso", "empresaConveniada"] as const;

const entradaContar = z
  .object({
    cidade: z.array(texto).max(10).optional(),
    statusConta: z.array(z.enum(STATUS)).max(3).optional(),
    faixaUso: z.array(z.enum(FAIXAS)).max(9).optional(),
    empresaConveniada: z.array(texto).max(10).optional(),
    perfilRenda: z.array(z.enum(PERFIS)).max(4).optional(),
    etapaUso: z.array(z.enum(ETAPAS)).max(5).optional(),
    saldoDisponivelMin: z.number().min(0).max(1e9).optional(),
    semUsoDiasMin: z.number().int().min(0).max(3650).optional(),
    usadoNosUltimosDias: z.number().int().min(0).max(3650).optional(),
    diasSemUsoRealMin: z.number().int().min(0).max(3650).optional(),
    diasSemUsoRealMax: z.number().int().min(0).max(3650).optional(),
    autorizacaoComunicacao: z.boolean().optional(),
    agruparPor: z.enum(AGRUPAR).optional(),
  })
  .strict();

const entradaHorarios = z
  .object({
    tipo: z.enum(["todos", "antecipacao", "compra"]).optional(),
    por: z.enum(["perfil", "cidade", "nenhum"]).optional(),
    dias: z.number().int().min(7).max(365).optional(),
  })
  .strict();

const entradaPeriodo = z.object({ dias: z.number().int().min(1).max(90).optional() }).strict();
const entradaCampanhas = z.object({ limite: z.number().int().min(1).max(20).optional() }).strict();
const entradaVazia = z.object({}).strict();

const schema = (properties: Record<string, unknown> = {}): Ferramenta["inputSchema"] => ({ type: "object", properties, required: [], additionalProperties: false });
const filtrosCC = {
  cidade: { type: "string", description: "Nome da cidade, como aparece no sistema (opcional)." },
  convenio: { type: "string", description: "Nome do convênio/empresa conveniada (opcional)." },
};

/** Link da lista na tela de clientes, só para filtros simples que a tela entende. */
function linkLista(f: z.infer<typeof entradaContar>): string | null {
  const unico = <T>(a?: T[]) => (a && a.length === 1 ? a[0] : undefined);
  const q = new URLSearchParams();
  const cidade = unico(f.cidade);
  const status = unico(f.statusConta);
  const faixa = unico(f.faixaUso);
  const conv = unico(f.empresaConveniada);
  if (cidade) q.set("cidade", cidade);
  if (status) q.set("statusConta", status);
  if (faixa) q.set("faixaUso", faixa);
  if (conv) q.set("empresaConveniada", conv);
  const simples =
    (!f.cidade || cidade) && (!f.statusConta || status) && (!f.faixaUso || faixa) && (!f.empresaConveniada || conv) &&
    f.perfilRenda === undefined && f.etapaUso === undefined && f.saldoDisponivelMin === undefined && f.semUsoDiasMin === undefined &&
    f.usadoNosUltimosDias === undefined && f.diasSemUsoRealMin === undefined && f.diasSemUsoRealMax === undefined && f.autorizacaoComunicacao === undefined;
  return simples && [...q.keys()].length > 0 ? `/clients?${q.toString()}` : null;
}

/** Comparação com a foto diária mais antiga da janela: só o que mudou, em números. */
export async function dadosComparacao(tenantId: string, dias: number) {
  const hoje = todayBrt();
  const [kpis, base] = await Promise.all([
    computeKpis(prisma, tenantId),
    prisma.dashboardSnapshot.findFirst({ where: { tenantId, day: { gte: addDays(hoje, -dias), lt: hoje } }, orderBy: { day: "asc" } }),
  ]);
  if (!base) return { disponivel: false, motivo: "O sistema ainda não tem uma foto diária anterior a hoje dentro desse período, então não há com o que comparar." };
  const distancia = Math.max(1, Math.round((hoje.getTime() - base.day.getTime()) / 86_400_000));
  const faixasBase = (base.faixas as Record<string, number> | null) ?? {};
  const limiteBase = Number(base.limiteTotal);
  const r = buildMelhorouCaiu(
    {
      totalClientes: kpis.totalClientes, ativos: kpis.ativos, inativos: kpis.inativos, semUso: kpis.semUso,
      indefinidos: kpis.faixas["INDEFINIDO"] ?? 0, usoLimitePct: kpis.limiteTotal > 0 ? (kpis.valorUtilizado / kpis.limiteTotal) * 100 : null, score: null,
    },
    {
      totalClientes: base.totalClientes, ativos: base.ativos, inativos: base.inativos, semUso: base.semUso,
      indefinidos: faixasBase["INDEFINIDO"] ?? 0, usoLimitePct: limiteBase > 0 ? (Number(base.valorUtilizado) / limiteBase) * 100 : null, score: null,
    },
    distancia
  );
  if (r.indisponivel) return { disponivel: false, motivo: "Base pequena demais para comparar com segurança." };
  const item = (direcao: "melhorou" | "caiu") => (i: (typeof r.melhorou)[number]) => ({
    indicador: i.titulo, direcao, anterior: i.anterior, atual: i.atual, variacao: i.abs, unidade: i.unidade === "pp" ? "pontos percentuais" : "pontos",
  });
  return {
    disponivel: true,
    comparadoCom: { dia: base.day.toISOString().slice(0, 10), diasAtras: distancia },
    criterio: "participação sobre o total de clientes (ativos, inativos, nunca usaram, sem limite) e uso do limite; só mudanças acima de um mínimo por indicador",
    melhorou: r.melhorou.map(item("melhorou")),
    caiu: r.caiu.map(item("caiu")),
    indicadoresSemMudancaRelevante: r.estaveis,
  };
}

/** Campanhas recentes com o que foi registrado de cada envio. Sem texto de mensagem nem destinatários. */
export async function dadosCampanhas(tenantId: string, limite: number) {
  const campanhas = await prisma.campaign.findMany({
    where: { tenantId, isSandbox: false },
    orderBy: { createdAt: "desc" },
    take: limite,
    select: { id: true, name: true, channel: true, status: true, audienceCount: true, createdAt: true },
  });
  if (campanhas.length === 0) return { campanhas: [] };
  const ids = campanhas.map((c) => c.id);
  const [porStatus, convertidos] = await Promise.all([
    prisma.messageEvent.groupBy({ by: ["campaignId", "status"], where: { campaignId: { in: ids } }, _count: { _all: true } }),
    prisma.messageEvent.groupBy({ by: ["campaignId"], where: { campaignId: { in: ids }, convertedAt: { not: null } }, _count: { _all: true } }),
  ]);
  const conv = new Map(convertidos.map((c) => [c.campaignId, c._count._all]));
  return {
    campanhas: campanhas.map((c) => {
      const s: Record<string, number> = {};
      for (const g of porStatus) if (g.campaignId === c.id) s[String(g.status).toLowerCase()] = g._count._all;
      const enviados = (s.enviado ?? 0) + (s.entregue ?? 0) + (s.lido ?? 0) + (s.respondido ?? 0);
      return {
        campanha: c.name, canal: c.channel, situacao: c.status, criadaEm: c.createdAt.toISOString().slice(0, 10), publico: c.audienceCount,
        mensagensPorSituacao: s, enviadasOuAlem: enviados, convertidas: conv.get(c.id) ?? 0,
      };
    }),
  };
}

export const FERRAMENTAS: Ferramenta[] = [
  {
    nome: "resumo_base",
    descricao: "Visão geral da base de clientes agora: total, ativos, inativos, bloqueados, nunca usaram, distribuição por faixa de uso do limite, limite total, valor utilizado e saldo disponível. Traz também a data de hoje. Aceita recorte por cidade ou convênio.",
    area: "dashboard",
    somenteLeitura: true,
    inputSchema: schema(filtrosCC),
    entrada: filtroCidadeConvenio,
    executar: async (ctx, e) => ({
      hoje: todayBrt().toISOString().slice(0, 10),
      recorte: { cidade: e.cidade ?? null, convenio: e.convenio ?? null },
      ...(await computeKpis(prisma, ctx.tenantId, { cidade: e.cidade, empresaConveniada: e.convenio })),
    }),
  },
  {
    nome: "contar_clientes",
    descricao: "Conta clientes que atendem a filtros e, opcionalmente, divide o total por cidade, situação da conta, faixa de uso ou convênio. Use para perguntas como 'quantos clientes de X têm saldo e não usam há 30 dias'. Devolve só números (e o link da lista na tela quando o filtro é simples), nunca nomes ou telefones.",
    area: "clients",
    somenteLeitura: true,
    inputSchema: schema({
      cidade: { type: "array", items: { type: "string" }, description: "Cidades (qualquer uma)." },
      statusConta: { type: "array", items: { type: "string", enum: [...STATUS] } },
      faixaUso: { type: "array", items: { type: "string", enum: [...FAIXAS] }, description: "Faixa de uso do limite (SEM_USO = 0%, USO_100 = limite esgotado)." },
      empresaConveniada: { type: "array", items: { type: "string" }, description: "Convênios (qualquer um)." },
      perfilRenda: { type: "array", items: { type: "string", enum: [...PERFIS] }, description: "Perfil de renda estimado pelo limite (PF1 até R$ 4.000 de salário ... PF4 acima de R$ 12.000)." },
      etapaUso: { type: "array", items: { type: "string", enum: [...ETAPAS] }, description: "Etapa pelo extrato de compras: NUNCA_USOU, RECORRENTE (3+ usos em 90 dias), OCASIONAL, EM_RISCO (31 a 90 dias sem uso), INATIVO (mais de 90)." },
      saldoDisponivelMin: { type: "number", description: "Saldo disponível mínimo em R$." },
      semUsoDiasMin: { type: "integer", description: "Última utilização registrada há pelo menos N dias (ou nunca usou)." },
      usadoNosUltimosDias: { type: "integer", description: "Usou nos últimos N dias." },
      diasSemUsoRealMin: { type: "integer", description: "Último uso pelo extrato de compras há pelo menos N dias (ou nunca usou)." },
      diasSemUsoRealMax: { type: "integer", description: "Último uso pelo extrato há no máximo N dias." },
      autorizacaoComunicacao: { type: "boolean", description: "Só quem autorizou receber comunicação." },
      agruparPor: { type: "string", enum: [...AGRUPAR], description: "Divide o total por este campo (até 20 grupos)." },
    }),
    entrada: entradaContar,
    executar: async (ctx, e: z.infer<typeof entradaContar>) => {
      const { agruparPor, ...filtros } = e;
      // LGPD: cliente anonimizado fica fora de toda contagem (como no dashboard).
      const where = { AND: [buildSegmentWhere(ctx.tenantId, filtros as SegmentFilters), { anonymizedAt: null }] };
      const total = await prisma.client.count({ where });
      const grupos = agruparPor
        ? (
            await prisma.client.groupBy({ by: [agruparPor], where, _count: { _all: true }, orderBy: { _count: { [agruparPor]: "desc" } }, take: 20 })
          ).map((g: any) => ({ valor: g[agruparPor] ?? "(vazio)", clientes: g._count._all }))
        : undefined;
      return { total, filtrosAplicados: filtros, agrupadoPor: agruparPor ?? null, grupos, linkLista: linkLista(e) };
    },
  },
  {
    nome: "oportunidades",
    descricao: "Públicos prontos para ação (clientes inativos, nunca usaram, faixas de uso do limite, comércio, aniversariantes etc.) com a quantidade de clientes em cada um e a variação observada contra a foto diária mais antiga dos últimos 30 dias, quando existir histórico.",
    area: "dashboard",
    somenteLeitura: true,
    inputSchema: schema(filtrosCC),
    entrada: filtroCidadeConvenio,
    executar: async (ctx, e) => adaptarOportunidades(await dadosOportunidades(ctx.tenantId, { cidade: e.cidade, empresaConveniada: e.convenio })),
  },
  {
    nome: "comparar_periodos",
    descricao: "O que melhorou e o que caiu na base (ativos, inativos, nunca usaram, sem limite, uso do limite) entre hoje e a foto diária mais antiga dentro dos últimos N dias (padrão 30). Só números observados.",
    area: "dashboard",
    somenteLeitura: true,
    inputSchema: schema({ dias: { type: "integer", description: "Janela em dias, de 1 a 90 (padrão 30)." } }),
    entrada: entradaPeriodo,
    executar: async (ctx, e) => dadosComparacao(ctx.tenantId, e.dias ?? 30),
  },
  {
    nome: "desempenho_cidades",
    descricao: "Taxa de uso do cartão por cidade (clientes com limite que usaram nos 30 dias até o último dia do extrato) e a variação contra os 30 dias anteriores, com clientes, inativos e a classificação por regra. Use para saber qual cidade usa mais, qual caiu e qual subiu.",
    area: "dashboard",
    somenteLeitura: true,
    inputSchema: schema(),
    entrada: entradaVazia,
    executar: async (ctx) => adaptarCidades(await dadosCidadesDesempenho(ctx.tenantId)),
  },
  {
    nome: "desempenho_convenios",
    descricao: "Por convênio (empresa conveniada): clientes, inativos, taxa de uso nos 30 dias até o último dia do extrato, variação contra os 30 anteriores e o lucro (juros das antecipações) nas duas janelas.",
    area: "dashboard",
    somenteLeitura: true,
    inputSchema: schema(),
    entrada: entradaVazia,
    executar: async (ctx) => adaptarConvenios(await dadosConvenios(ctx.tenantId)),
  },
  {
    nome: "financeiro_mes",
    descricao: "Lucro (juros das antecipações) acumulado no mês do último extrato contra o mês anterior até o mesmo dia: lucro, antecipações, ticket médio, lucro por cliente que usou, divisão por semana, cidade e perfil de renda, e o progresso contra as metas cadastradas. Compra à vista não entra no lucro (o ganho dela é desconhecido).",
    area: "dashboard",
    somenteLeitura: true,
    inputSchema: schema(),
    entrada: entradaVazia,
    executar: async (ctx) => adaptarFinanceiro(await dadosFinanceiro(ctx.tenantId)),
  },
  {
    nome: "uso_por_hora",
    descricao: "Em que horas do dia (Brasília) os clientes usaram o cartão, a hora de pico observada e, por segmento (perfil de renda ou cidade), o mesmo detalhe. 'tipo': antecipacao (saque), compra ou todos. Só horários registrados no extrato.",
    area: "dashboard",
    somenteLeitura: true,
    inputSchema: schema({
      tipo: { type: "string", enum: ["todos", "antecipacao", "compra"] },
      por: { type: "string", enum: ["perfil", "cidade", "nenhum"], description: "Como segmentar (padrão perfil)." },
      dias: { type: "integer", description: "Janela em dias, de 7 a 365 (padrão 90)." },
    }),
    entrada: entradaHorarios,
    executar: async (ctx, e) => adaptarHorarios(await dadosHorarios(ctx.tenantId, { dias: e.dias ?? 90, tipo: e.tipo ?? "todos", por: e.por ?? "perfil" })),
  },
  {
    nome: "fontes_de_dados",
    descricao: "Há quantos dias cada fonte de dados foi atualizada (extrato de compras, planilha de cartões e contas, foto diária) e a data da última mensagem recebida e do último disparo. Use para avisar se os números estão desatualizados.",
    area: "dashboard",
    somenteLeitura: true,
    inputSchema: schema(),
    entrada: entradaVazia,
    executar: async (ctx) => dadosFontes(ctx.tenantId),
  },
  {
    nome: "campanhas_recentes",
    descricao: "As campanhas mais recentes (sem as de teste) com público, situação e o que foi registrado dos envios: enviadas, entregues, lidas, respondidas, falhas, bloqueadas e convertidas. Não traz o texto das mensagens nem os destinatários.",
    area: "campaigns",
    somenteLeitura: true,
    inputSchema: schema({ limite: { type: "integer", description: "Quantas campanhas, de 1 a 20 (padrão 8)." } }),
    entrada: entradaCampanhas,
    executar: async (ctx, e) => dadosCampanhas(ctx.tenantId, e.limite ?? 8),
  },
];

export const NOMES_FERRAMENTAS = FERRAMENTAS.map((f) => f.nome);

export interface ResultadoFerramenta {
  ok: boolean;
  /** Texto devolvido ao modelo (JSON ou mensagem de erro). */
  conteudo: string;
}

const MAX_RESULTADO = 24_000;

/** Valida a entrada, confere o acesso, executa e devolve o resultado sem projeções nem dados pessoais. */
export async function executarFerramenta(nome: string, entradaBruta: unknown, ctx: ContextoFerramenta): Promise<ResultadoFerramenta> {
  const f = FERRAMENTAS.find((x) => x.nome === nome);
  if (!f) return { ok: false, conteudo: `Ferramenta desconhecida: ${nome}. Use apenas: ${NOMES_FERRAMENTAS.join(", ")}.` };
  if (ctx.podeUsar && !ctx.podeUsar(f.area)) return { ok: false, conteudo: "O perfil de acesso de quem perguntou não inclui esta informação. Diga isso na resposta." };
  const parsed = f.entrada.safeParse(entradaBruta ?? {});
  if (!parsed.success) return { ok: false, conteudo: `Parâmetros inválidos: ${parsed.error.issues.map((i) => `${i.path.join(".") || "entrada"}: ${i.message}`).join("; ")}` };
  try {
    const dados = sanitizar(await f.executar(ctx, parsed.data));
    let texto = JSON.stringify(dados);
    if (texto.length > MAX_RESULTADO) texto = `${texto.slice(0, MAX_RESULTADO)}… [resultado cortado por tamanho: peça um recorte menor]`;
    return { ok: true, conteudo: texto };
  } catch (e) {
    console.error(`[assistente] ferramenta ${nome} falhou:`, e);
    return { ok: false, conteudo: "Não foi possível consultar este dado agora. Informe isso na resposta, sem inventar o valor." };
  }
}

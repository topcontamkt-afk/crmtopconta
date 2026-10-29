import { restricaoDeEnvio } from "./envioRestrito";
import { AppPrismaClient } from "../config/db";
import { tenantRaw } from "../config/db";
import { buscarEmPartes, contarEmPartes } from "../config/d1Partes";
import { hasRealWhatsApp } from "./campaignQueue";
import { avaliarFrescor, mensagemFrescor } from "./dataFreshness";
import { ManualRowInput, prepareManual } from "./manualCampaign";
import { costConfigFrom, estimateCost } from "./messageCost";
import { AVISO_RENDA_IGNORADA, buildSegmentWhere, ENVIAVEL_WHERE, filtrosRendaIgnorados, SegmentFilters, SegmentGroup } from "./segments";
import { unmappedPositions } from "./templateImport";
import { linkBase, trackedButtons } from "./trackedLinks";
import { BASE_LEGAL_LABEL, baseLegalVigente, liaPendente, SEM_BASE_LEGAL } from "./baseLegal";
import { CONTATO_LIBERADO_WHERE } from "./privacy";
import { montarRodape } from "./templateVariables";
import { templateTemOptOut } from "./whatsappTemplates";

/**
 * Passo "Validação" do assistente de campanhas: confere template, conexão com a Meta, público, dedupe,
 * extrato e custo ANTES de lançar, e devolve uma lista de conferências (ok / aviso / erro). Só lê.
 */

export type WizardAudience =
  | { tipo: "todos" }
  | { tipo: "segmento"; segmentId: string }
  | { tipo: "filtros"; filters: Record<string, unknown> }
  | { tipo: "lista"; clientIds: string[] }
  | { tipo: "planilha"; rows: ManualRowInput[] };

export type CheckLevel = "ok" | "aviso" | "erro";
export interface Check {
  id: string;
  nivel: CheckLevel;
  titulo: string;
  detalhe?: string;
}

export interface WizardValidation {
  contatos: number;
  total: number;
  checks: Check[];
  custo: { categoria: string | null; brl: number | null; total: number | null; usd: number | null; cambio: number };
  podeLancar: boolean;
  /** linhas da planilha recusadas (até 200) */
  motivos: { linha: number; motivo: string }[];
  /** LGPD 02-02: contatos da planilha que não são clientes (exigem a origem do consentimento ao lançar) */
  foraDaBase: number;
}

export const DEDUPE_HORAS_PADRAO = 72;

/** Horário (Brasília) em que o envio automático diário roda hoje (vercel.json: 0 9 * * * UTC). */
export const CICLO_DIARIO_BRASILIA = "06h";

export async function baseFilters(prisma: AppPrismaClient, tenantId: string, a: WizardAudience): Promise<SegmentFilters | SegmentGroup | null> {
  if (a.tipo === "todos") return {};
  if (a.tipo === "filtros") return a.filters as SegmentFilters;
  if (a.tipo === "lista") return { clientIds: a.clientIds };
  if (a.tipo === "segmento") {
    const seg = await prisma.segmentDefinition.findFirst({ where: { id: a.segmentId, tenantId } });
    return seg ? ((seg.filters as any) ?? {}) : null;
  }
  return null;
}

export async function validateWizard(
  prisma: AppPrismaClient,
  tenantId: string,
  input: { templateId: string; audience: WizardAudience; scheduledAt?: string | null; now?: Date }
): Promise<WizardValidation> {
  const now = input.now ?? new Date();
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  const [template, tenant, real] = await Promise.all([
    prisma.messageTemplate.findFirst({ where: { id: input.templateId, tenantId }, include: { media: { select: { id: true } } } }),
    prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: {
        custoMarketingUsd: true, custoUtilidadeUsd: true, cambioUsdBrl: true, cpfSalt: true, whatsappProvider: true,
        name: true, controladorNome: true, rodapeOptOut: true, baseLegalMarketing: true, liaVersao: true, liaAprovadaEm: true,
      },
    }),
    hasRealWhatsApp(prisma, tenantId),
  ]);

  const zapi = tenant.whatsappProvider === "ZAPI";

  // 0) LGPD 02-01: base legal declarada pelo controlador (sem ela nada é enviado)
  const base = baseLegalVigente(tenant);
  if (!base) {
    add({ id: "base_legal", nivel: "erro", titulo: "Base legal não declarada", detalhe: SEM_BASE_LEGAL });
  } else if (base === "CONSENTIMENTO") {
    // art. 8º, §2º: a prova do consentimento é do controlador e o CRM não guarda o aceite por titular
    add({ id: "base_legal", nivel: "aviso", titulo: `Base legal: ${BASE_LEGAL_LABEL[base]}`, detalhe: "O CRM não registra o aceite de cada pessoa: a autorização vem da planilha. Confirme que o controlador tem a prova do consentimento de todo o público." });
  } else if (liaPendente(tenant)) {
    add({ id: "base_legal", nivel: "aviso", titulo: `Base legal: ${BASE_LEGAL_LABEL[base]}, LIA pendente`, detalhe: "O teste de balanceamento (LIA) ainda não foi registrado com versão e data de aprovação. Registre em Configurações → LGPD." });
  } else {
    add({ id: "base_legal", nivel: "ok", titulo: `Base legal: ${BASE_LEGAL_LABEL[base]}` });
  }

  // 1) template
  if (!template || template.channel !== "WHATSAPP") {
    add({ id: "template", nivel: "erro", titulo: "Template não encontrado", detalhe: "Volte ao passo 1 e escolha um template." });
  } else if (zapi) {
    // Z-API manda só o TEXTO do template (variáveis preenchidas): não precisa de aprovação da Meta
    if (unmappedPositions(template.variableMap as any).length) {
      add({ id: "template", nivel: "erro", titulo: "Variáveis do template sem significado", detalhe: `Defina o que ${unmappedPositions(template.variableMap as any).map((n) => `{{${n}}}`).join(", ")} representa, no passo 1.` });
    } else {
      add({ id: "template", nivel: "ok", titulo: "Texto do template", detalhe: template.name });
    }
    if (template.headerFormat === "IMAGE" || trackedButtons(template).length > 0 || (Array.isArray(template.buttons) && template.buttons.length > 0) || (Array.isArray(template.quickReplies) && template.quickReplies.length > 0)) {
      add({ id: "zapi_formato", nivel: "aviso", titulo: "Imagem e botões não vão pela Z-API", detalhe: "Só o texto é enviado. O link rastreado do botão também não vai." });
    }
    // LGPD 02-07: rodapé e botão SAIR do template não vão pela Z-API; o rodapé do controlador vai como texto
    add({ id: "rodape", nivel: "ok", titulo: "Rodapé de descadastro vai no texto", detalhe: `Cada mensagem termina com: "${montarRodape(tenant)}"` });
  } else if (template.status !== "APROVADO") {
    add({ id: "template", nivel: "erro", titulo: "Template não aprovado", detalhe: `Status: ${template.metaStatus ?? template.status}. Só template aprovado pela Meta pode ser enviado.` });
  } else if (real && template.metaStatus !== "APPROVED") {
    add({ id: "template", nivel: "erro", titulo: "Template sem aprovação da Meta", detalhe: "Sincronize os templates ou aguarde a aprovação." });
  } else if (template.sendIssue) {
    add({ id: "template", nivel: "erro", titulo: "Template com formato não suportado", detalhe: template.sendIssue });
  } else if (unmappedPositions(template.variableMap as any).length) {
    add({ id: "template", nivel: "erro", titulo: "Variáveis do template sem significado", detalhe: `Defina o que ${unmappedPositions(template.variableMap as any).map((n) => `{{${n}}}`).join(", ")} representa, no passo 1.` });
  } else if (template.headerFormat === "IMAGE" && !template.media) {
    add({ id: "template", nivel: "erro", titulo: "Falta a imagem do cabeçalho", detalhe: "Envie a imagem do template em Templates." });
  } else {
    add({ id: "template", nivel: "ok", titulo: "Template aprovado pela Meta", detalhe: template.name });
  }

  // LGPD 02-05: template da Meta vai como aprovado (não dá para acrescentar texto): avisa se não ensina a parar
  if (template && template.channel === "WHATSAPP" && !zapi && template.category !== "UTILITY" && !templateTemOptOut(template)) {
    add({
      id: "rodape",
      nivel: "aviso",
      titulo: "O template não ensina a parar de receber",
      detalhe: template.origin === "META"
        ? "Este template veio da Meta sem rodapé nem botão de saída (ex.: \"Responda SAIR...\" ou botão SAIR). O texto só muda na Meta: prefira um template com a instrução de descadastro."
        : "Edite o template e inclua um rodapé \"Responda SAIR para não receber mais mensagens\" ou um botão de resposta rápida SAIR.",
    });
  }

  if (template && !zapi && trackedButtons(template).length > 0) {
    const base = linkBase();
    if (base) add({ id: "link", nivel: "ok", titulo: "Link rastreado no botão", detalhe: `Cada cliente recebe um link único (${base}/r/…); o clique aparece no relatório.` });
    else add({ id: "link", nivel: "erro", titulo: "Link rastreado no botão", detalhe: "Falta o domínio dos links (LINK_BASE_URL ou PUBLIC_BACKEND_URL): o botão não teria para onde levar." });
  }

  // 2) conexão
  if (zapi) {
    if (real) {
      add({ id: "conexao", nivel: "ok", titulo: "WhatsApp ativo: Z-API" });
      add({ id: "zapi_risco", nivel: "aviso", titulo: "Z-API é não oficial", detalhe: "O envio sai devagar, em lotes pequenos, e há risco de o WhatsApp bloquear o número. Prefira a Meta para campanhas grandes." });
    } else {
      add({ id: "conexao", nivel: "erro", titulo: "Z-API não configurada", detalhe: "O WhatsApp ativo é a Z-API, mas ela não está configurada. Veja Configurações → WhatsApp." });
    }
  } else if (real) add({ id: "conexao", nivel: "ok", titulo: "WhatsApp conectado" });
  else add({ id: "conexao", nivel: "aviso", titulo: "Nenhum WhatsApp real conectado", detalhe: "O envio será simulado (nada sai de verdade). Configure em Integrações." });

  // 3) público
  const a = input.audience;
  let contatos = 0;
  let total = 0;
  let motivos: { linha: number; motivo: string }[] = [];
  let foraDaBase = 0;
  const usaBase = a.tipo !== "planilha";

  if (a.tipo === "planilha") {
    const r = template ? await prepareManual(prisma, tenantId, a.rows, template.id) : null;
    if (r && !("error" in r)) {
      contatos = r.enviar.length;
      total = a.rows.length;
      motivos = r.rejected.slice(0, 200);
      add({
        id: "publico",
        nivel: contatos > 0 ? "ok" : "erro",
        titulo: `${contatos} de ${total} contatos vão receber`,
        detalhe: `${r.daBase} são clientes da base (medidos pelo uso real) e ${contatos - r.daBase} estão fora da base (ficam guardados para análise).`,
      });
      foraDaBase = contatos - r.daBase;
      // LGPD 02-02: não cliente não tem relação prévia com o controlador: só com consentimento declarado
      if (foraDaBase > 0) {
        add({ id: "consentimento", nivel: "aviso", titulo: `${foraDaBase} contato(s) não são clientes: informe a origem do consentimento`, detalhe: "Para quem não é cliente, a mensagem só pode sair com consentimento. Ao lançar, descreva onde e como ele foi coletado; fica gravado na campanha com o seu usuário e a data." });
      }
      if (r.rejected.length) add({ id: "recusadas", nivel: "aviso", titulo: `${r.rejected.length} linhas recusadas`, detalhe: "Telefone/CPF inválido, repetido, opt-out ou sem limite disponível quando o template usa. Veja a lista abaixo." });
    } else {
      add({ id: "publico", nivel: "erro", titulo: "Não consegui conferir a lista", detalhe: r && "error" in r ? r.error : "Escolha um template primeiro." });
    }
  } else {
    const filters = await baseFilters(prisma, tenantId, a);
    if (filters === null) {
      add({ id: "publico", nivel: "erro", titulo: "Segmento não encontrado" });
    } else if (filtrosRendaIgnorados(filters).length) {
      add({ id: "publico", nivel: "erro", titulo: "Segmento com filtro de renda", detalhe: AVISO_RENDA_IGNORADA });
    } else {
      const where = buildSegmentWhere(tenantId, filters);
      const eligible = { ...where, ...CONTATO_LIBERADO_WHERE, statusConta: { not: "BLOQUEADO" as const }, ...ENVIAVEL_WHERE };
      [total, contatos] = await Promise.all([
        contarEmPartes(where, (w) => prisma.client.count({ where: w })),
        contarEmPartes(eligible, (w) => prisma.client.count({ where: w })),
      ]);
      add({ id: "publico", nivel: contatos > 0 ? "ok" : "erro", titulo: `${contatos} clientes elegíveis` });
      if (total > contatos) {
        add({ id: "excluidos", nivel: "ok", titulo: `${total - contatos} ficam de fora`, detalhe: "Opt-out, conta bloqueada, tratamento suspenso a pedido do titular ou sem limite (comércio credenciado) são excluídos automaticamente." });
      }

      // dedupe: quem já recebeu este mesmo texto na janela
      if (template && contatos > 0) {
        const cutoff = new Date(now.getTime() - DEDUPE_HORAS_PADRAO * 3600_000);
        const ids = (await buscarEmPartes(eligible, (w) => prisma.client.findMany({ where: w, select: { id: true }, take: 100_000 }))).map((c) => c.id);
        // `not` ao lado do `in`: o Prisma não divide, então vai em pedaços que cabem no D1
        const repetidos = await contarEmPartes(
          { clientId: { in: ids }, queuedAt: { gte: cutoff }, status: { not: "CONTROLE" as const }, campaign: { tenantId, messageTemplate: template.body } },
          async (w) => (await prisma.messageEvent.findMany({ where: w, select: { clientId: true }, distinct: ["clientId"] })).length,
          "clientId"
        );
        if (repetidos > 0) add({ id: "dedupe", nivel: "aviso", titulo: `${repetidos} já receberam este texto nas últimas ${DEDUPE_HORAS_PADRAO}h`, detalhe: "Eles são pulados no envio para não repetir a mensagem." });
      }
    }
  }

  // 4) extrato de compras (só faz sentido para público da base)
  if (usaBase) {
    // SQL cru devolve o DateTime como texto ISO (SQLite)
    const [r] = await tenantRaw.query<Array<{ ultima: string | null }>>(`SELECT MAX("occurredAt") AS ultima FROM "Purchase" WHERE "tenantId" = $1`, tenantId);
    const f = avaliarFrescor(r?.ultima ? new Date(r.ultima) : null, now);
    const msg = mensagemFrescor(f);
    if (msg) add({ id: "extrato", nivel: "aviso", titulo: "Extrato de compras desatualizado", detalhe: `${msg} O resultado da campanha depende do extrato.` });
  }

  // 5) agendamento
  if (input.scheduledAt) {
    add({
      id: "agenda",
      nivel: "aviso",
      titulo: "Envio agendado sai no ciclo diário",
      detalhe: `No plano atual da Vercel o envio automático roda uma vez por dia (por volta das ${CICLO_DIARIO_BRASILIA}, Brasília). A campanha só entra nesse ciclo depois do horário marcado; para enviar na hora, use "Imediato".`,
    });
  }

  // 5b) homologação: só envia para números de teste
  const restricao = restricaoDeEnvio();
  if (restricao.ativa) {
    add({
      id: "homologacao",
      nivel: "aviso",
      titulo: "Homologação: envio só para números de teste",
      detalhe: `Neste ambiente nada é enviado de verdade, exceto para ${restricao.permitidos.size} número(s) da lista de teste. Os demais ficam bloqueados.`,
    });
  }

  // 6) custo
  const cfg = costConfigFrom(tenant);
  const cost = estimateCost(template?.category, cfg, contatos);
  if (cost.brl === null) add({ id: "custo", nivel: "aviso", titulo: "Custo não calculado", detalhe: "Informe o valor da categoria do template em \"Configurar custos\"." });
  else add({ id: "custo", nivel: "ok", titulo: `Custo estimado: ${cost.total!.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}`, detalhe: `${cost.brl.toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2, maximumFractionDigits: 4 })} por mensagem (${cost.categoria === "MARKETING" ? "marketing" : "utilidade"}).` });

  return {
    contatos,
    total,
    checks,
    custo: { categoria: cost.categoria, brl: cost.brl, total: cost.total, usd: cost.usd, cambio: cfg.cambioUsdBrl },
    podeLancar: contatos > 0 && !checks.some((c) => c.nivel === "erro"),
    motivos,
    foraDaBase,
  };
}

import { AppPrismaClient } from "../config/db";
import { logAudit } from "../middleware/audit";
import { notify } from "./notifications";
import { enqueueCampaign, processQueueBatch } from "./campaignQueue";
import { buildSegmentWhere, ENVIAVEL_WHERE, SALDO_MINIMO_ELEGIVEL } from "./segments";
import { avaliarFrescor } from "./dataFreshness";
import { isEtapaUso } from "./etapaUso";
import { isPerfilRenda } from "./rendaPerfil";
import { runWithTenantContextAsync, withCrossTenantAccess } from "../config/tenantGuard";
import { cidadeKey } from "./cidades";
import { diasAberturaNaFaixa } from "./ciclos";

/**
 * Motor de automação (Fase 2): avalia periodicamente as AutomationRule ativas de cada tenant
 * e executa a ação configurada sobre os clientes que casam com o gatilho.
 *
 * Gatilhos suportados (PRD):
 *  - NOVO_CLIENTE_SEM_USO: cliente cadastrado há N dias (condition.diasDesdeCadastro, default 7)
 *    e ainda na faixa "não utilizou".
 *  - INATIVO_30_DIAS: sem uso há N dias (condition.dias, default 30).
 *  - LIMITE_RENOVADO: teve um Movement do tipo "renovacao_limite" nas últimas N horas
 *    (condition.horasJanela, default 24) — ver hook em importService.ts.
 *  - ESTIMULO_FAIXA: clientes na faixa condition.faixa (obrigatório).
 *  - CICLO_ABERTO: o ciclo da cidade do cliente abriu há N dias (condition.diasAposAbertura, default 0 = no dia
 *    da abertura, quando o limite renova), opcionalmente só em certas cidades (condition.cidades = chaves de
 *    CicloCidade; vazio = todas as cadastradas), com perfilRenda/etapaUso/comSaldo opcionais. Devolve UM grupo
 *    por cidade: cada cidade vira sua própria campanha (resultado separado) e só dispara no dia dela.
 *  - OPT_OUT_TELEFONE_INVALIDO: inconsistências de opt-out (autorização=true com optOutAt
 *    preenchido) — a ação aqui é sempre "block", corrigindo o dado.
 *
 * Ações suportadas:
 *  - { type: 'campaign', channel, templateId? | messageTemplate?, throttlePerMin?, ... }:
 *    cria uma campanha (adHocFilters com os ids explícitos dos clientes casados) e já
 *    dispara o primeiro lote, respeitando dedupe/throttle/rate-limit normalmente.
 *  - { type: 'notification', message? }: cria uma Notification resumindo quantos clientes casaram.
 *  - { type: 'block' }: corrige/bloqueia os clientes casados diretamente (sem campanha).
 */

interface MatchResult {
  clientIds: string[];
  /** quando presente, cada grupo é executado à parte (ex.: uma campanha por cidade) */
  grupos?: { label: string; clientIds: string[] }[];
}

async function matchClients(prisma: AppPrismaClient, tenantId: string, trigger: string, condition: any): Promise<MatchResult> {
  switch (trigger) {
    case "NOVO_CLIENTE_SEM_USO": {
      const dias = condition?.diasDesdeCadastro ?? 7;
      const cutoff = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);
      const clients = await prisma.client.findMany({
        where: {
          tenantId,
          faixaUso: "SEM_USO",
          createdAt: { lte: cutoff },
          autorizacaoComunicacao: true,
          optOutAt: null,
          statusConta: "ATIVO",
        },
        select: { id: true },
      });
      return { clientIds: clients.map((c) => c.id) };
    }

    case "INATIVO_30_DIAS": {
      const dias = condition?.dias ?? 30;
      const cutoff = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);
      const clients = await prisma.client.findMany({
        where: {
          tenantId,
          OR: [{ dataUltimaUtilizacao: { lte: cutoff } }, { dataUltimaUtilizacao: null, createdAt: { lte: cutoff } }],
          autorizacaoComunicacao: true,
          optOutAt: null,
          statusConta: "ATIVO",
        },
        select: { id: true },
      });
      return { clientIds: clients.map((c) => c.id) };
    }

    case "LIMITE_RENOVADO": {
      const horas = condition?.horasJanela ?? 24;
      const cutoff = new Date(Date.now() - horas * 60 * 60 * 1000);
      const movements = await prisma.movement.findMany({
        where: { tipo: "renovacao_limite", data: { gte: cutoff }, client: { tenantId, autorizacaoComunicacao: true, optOutAt: null } },
        select: { clientId: true },
        distinct: ["clientId"],
      });
      return { clientIds: movements.map((m) => m.clientId) };
    }

    case "ESTIMULO_FAIXA": {
      if (!condition?.faixa) return { clientIds: [] };
      const clients = await prisma.client.findMany({
        where: {
          tenantId,
          faixaUso: condition.faixa,
          autorizacaoComunicacao: true,
          optOutAt: null,
          statusConta: "ATIVO",
        },
        select: { id: true },
      });
      return { clientIds: clients.map((c) => c.id) };
    }

    case "ETAPA_PERFIL": {
      // condition: { etapaUso?, perfilRenda?, comSaldo? }. Pelo menos um dos dois filtros é obrigatório
      // (senão a regra miraria a base inteira). Etapa de uso depende do extrato: com o extrato velho
      // (ver dataFreshness.ts) a regra não dispara — quem "parou de usar" seria só falta de planilha.
      const etapa = isEtapaUso(condition?.etapaUso) ? condition.etapaUso : undefined;
      const perfil = isPerfilRenda(condition?.perfilRenda) ? condition.perfilRenda : undefined;
      if (!etapa && !perfil) return { clientIds: [] };
      if (etapa) {
        const ultima = await prisma.purchase.aggregate({ where: { tenantId }, _max: { occurredAt: true } });
        const frescor = avaliarFrescor(ultima._max.occurredAt);
        if (frescor.status !== "OK") {
          console.warn(`[automation] ETAPA_PERFIL ignorada: extrato de compras ${frescor.status} (tenant ${tenantId})`);
          return { clientIds: [] };
        }
      }
      const clients = await prisma.client.findMany({
        where: {
          AND: [
            buildSegmentWhere(tenantId, {
              etapaUso: etapa ? [etapa] : undefined,
              perfilRenda: perfil ? [perfil] : undefined,
              saldoDisponivelMin: condition?.comSaldo ? SALDO_MINIMO_ELEGIVEL : undefined,
            }),
            ENVIAVEL_WHERE,
            { autorizacaoComunicacao: true, optOutAt: null, statusConta: "ATIVO" },
          ],
        },
        select: { id: true },
      });
      return { clientIds: clients.map((c) => c.id) };
    }

    case "CICLO_ABERTO": {
      const apos = Number.isInteger(condition?.diasAposAbertura) && condition.diasAposAbertura >= 0 && condition.diasAposAbertura <= 30 ? condition.diasAposAbertura : 0;
      const configs = await prisma.cicloCidade.findMany({ where: { tenantId } });
      const escolhidas = Array.isArray(condition?.cidades) && condition.cidades.length ? new Set<string>(condition.cidades) : null;
      const hoje = diasAberturaNaFaixa({ min: apos, max: apos }, "abriuHa");
      const etapa = isEtapaUso(condition?.etapaUso) ? condition.etapaUso : undefined;
      const perfil = isPerfilRenda(condition?.perfilRenda) ? condition.perfilRenda : undefined;
      if (etapa) {
        const ultima = await prisma.purchase.aggregate({ where: { tenantId }, _max: { occurredAt: true } });
        if (avaliarFrescor(ultima._max.occurredAt).status !== "OK") {
          console.warn(`[automation] CICLO_ABERTO ignorada: extrato de compras desatualizado e a regra usa etapa de uso (tenant ${tenantId})`);
          return { clientIds: [] };
        }
      }
      const alvo = configs.filter((c) => hoje.includes(c.diaAbertura) && (!escolhidas || escolhidas.has(c.cidadeKey)));
      if (alvo.length === 0) return { clientIds: [] };
      const clients = await prisma.client.findMany({
        where: {
          AND: [
            buildSegmentWhere(tenantId, {
              perfilRenda: perfil ? [perfil] : undefined,
              etapaUso: etapa ? [etapa] : undefined,
              saldoDisponivelMin: condition?.comSaldo ? SALDO_MINIMO_ELEGIVEL : undefined,
            }),
            ENVIAVEL_WHERE,
            { diaCicloAbertura: { in: [...new Set(alvo.map((c) => c.diaAbertura))] }, autorizacaoComunicacao: true, optOutAt: null, statusConta: "ATIVO" },
          ],
        },
        select: { id: true, cidade: true },
      });
      const grupos = alvo
        .map((c) => ({ label: c.cidade, clientIds: clients.filter((cl) => cidadeKey(cl.cidade) === c.cidadeKey).map((cl) => cl.id) }))
        .filter((g) => g.clientIds.length > 0);
      return { clientIds: grupos.flatMap((g) => g.clientIds), grupos };
    }

    case "OPT_OUT_TELEFONE_INVALIDO": {
      // Inconsistência: autorização marcada como concedida mas com opt-out já registrado
      // (ex.: corrida entre uma importação e um opt-out manual). Auto-corrige bloqueando.
      const clients = await prisma.client.findMany({
        where: { tenantId, autorizacaoComunicacao: true, optOutAt: { not: null } },
        select: { id: true },
      });
      return { clientIds: clients.map((c) => c.id) };
    }

    default:
      return { clientIds: [] };
  }
}

async function executeAction(prisma: AppPrismaClient, tenantId: string, ruleId: string, ruleName: string, action: any, clientIds: string[], label?: string) {
  if (clientIds.length === 0) return { executed: false, reason: "sem clientes elegíveis" };

  if (action.type === "block") {
    // clientIds already came from a tenantId-scoped matchClients() query above, but the
    // updateMany itself is re-scoped by tenantId too (defense in depth — see tenantGuard.ts):
    // a future change to matchClients()/executeAction() that lets clientIds come from
    // somewhere else shouldn't silently become a cross-tenant bulk mutation.
    await prisma.client.updateMany({
      where: { id: { in: clientIds }, tenantId },
      data: { autorizacaoComunicacao: false, optOutAt: new Date() },
    });
    await logAudit({ tenantId, action: "AUTOMATION_BLOCK", target: "Client", details: { ruleId, ruleName, count: clientIds.length } });
    return { executed: true, affected: clientIds.length };
  }

  if (action.type === "notification") {
    await notify(prisma, {
      tenantId,
      type: "AUTOMATION_FIRED",
      severity: "INFO",
      message: action.message || `Regra "${ruleName}"${label ? ` (${label})` : ""} identificou ${clientIds.length} cliente(s) elegível(is).`,
      relatedType: "AutomationRule",
      relatedId: ruleId,
    });
    return { executed: true, affected: clientIds.length };
  }

  if (action.type === "campaign") {
    let messageTemplate = action.messageTemplate as string | undefined;
    if (action.templateId) {
      const template = await prisma.messageTemplate.findFirst({ where: { id: action.templateId, tenantId } });
      if (!template || template.status !== "APROVADO") {
        await notify(prisma, {
          tenantId,
          type: "AUTOMATION_BLOCKED",
          severity: "AVISO",
          message: `Regra "${ruleName}" não pôde disparar: template não encontrado ou não aprovado.`,
          relatedType: "AutomationRule",
          relatedId: ruleId,
        });
        return { executed: false, reason: "template não aprovado" };
      }
      messageTemplate = template.body;
    }
    if (!messageTemplate) return { executed: false, reason: "sem mensagem configurada" };

    const campaignName = `Automação: ${ruleName}${label ? ` · ${label}` : ""} (${new Date().toISOString().slice(0, 10)})`;
    // Já disparou hoje (ex.: "rodar agora" depois do ciclo diário): não cria campanha repetida.
    if (label && (await prisma.campaign.findFirst({ where: { tenantId, name: campaignName }, select: { id: true } }))) {
      return { executed: false, reason: "já disparou hoje" };
    }

    const campaign = await prisma.campaign.create({
      data: {
        tenantId,
        name: campaignName,
        objective: `Disparo automático da regra "${ruleName}"`,
        channel: action.channel || "WHATSAPP",
        adHocFilters: { clientIds } as any,
        templateId: action.templateId,
        messageTemplate,
        throttlePerMin: action.throttlePerMin || 60,
        dedupeWindowHrs: action.dedupeWindowHrs || 72,
        attributionDays: action.attributionDays || 7,
        costPerMessage: action.costPerMessage || 0,
        status: "RASCUNHO",
      },
    });

    const enqueueResult = await enqueueCampaign(prisma, tenantId, campaign.id);
    // Dispara imediatamente o(s) primeiro(s) lote(s) — o restante, se houver, é drenado pelo
    // sweep periódico de campanhas em andamento no scheduler.
    const primeiro = await processQueueBatch(prisma, campaign.id, Math.min(500, enqueueResult.queued));
    if (label && (primeiro.remaining > 0 || (primeiro as any).bloqueado)) {
      await notify(prisma, {
        tenantId,
        type: "AUTOMATION_FIRED",
        severity: "AVISO",
        message: `Campanha "${campaignName}": ${primeiro.processed} enviada(s), ${primeiro.remaining} na fila.` + ((primeiro as any).bloqueado ? ` ${(primeiro as any).bloqueado}` : " O restante sai nos próximos ciclos de disparo, ou use “Disparar lote” na campanha."),
        relatedType: "Campaign",
        relatedId: campaign.id,
      });
    }

    await logAudit({
      tenantId,
      action: "AUTOMATION_CAMPAIGN_CREATED",
      target: "Campaign",
      targetId: campaign.id,
      details: { ruleId, ruleName, ...enqueueResult },
    });
    return { executed: true, campaignId: campaign.id, ...enqueueResult };
  }

  return { executed: false, reason: `tipo de ação desconhecido: ${action.type}` };
}

export interface RuleRunResult {
  matched: number;
  executed?: boolean;
  [k: string]: unknown;
}

/**
 * Avalia UMA regra no contexto do tenant dela. Com `simular`, só conta quem casaria (por grupo, ex.: cidade) e não
 * executa nada. Regras com grupos (CICLO_ABERTO) executam a ação uma vez por grupo.
 */
export async function runRule(
  prisma: AppPrismaClient,
  rule: { id: string; tenantId: string; name: string; trigger: string; condition: unknown; action: unknown },
  opts: { simular?: boolean } = {}
): Promise<RuleRunResult> {
  return runWithTenantContextAsync(rule.tenantId, async () => {
    const { clientIds, grupos } = await matchClients(prisma, rule.tenantId, rule.trigger, rule.condition);
    if (opts.simular) {
      return { matched: clientIds.length, simulado: true, grupos: grupos?.map((g) => ({ label: g.label, total: g.clientIds.length })) };
    }
    let actionResult: any;
    if (grupos) {
      const porGrupo = [];
      for (const g of grupos) porGrupo.push({ label: g.label, ...(await executeAction(prisma, rule.tenantId, rule.id, rule.name, rule.action, g.clientIds, g.label)) });
      actionResult = { executed: porGrupo.some((r: any) => r.executed), grupos: porGrupo };
    } else {
      actionResult = await executeAction(prisma, rule.tenantId, rule.id, rule.name, rule.action, clientIds);
    }
    await prisma.automationRule.update({ where: { id: rule.id }, data: { lastRunAt: new Date() } });
    return { matched: clientIds.length, ...actionResult };
  });
}

export async function evaluateAutomationRules(prisma: AppPrismaClient) {
  // Genuinely cross-tenant by design: this is the periodic scheduler entry point (see
  // services/scheduler.ts runAutomationJob) that evaluates every enabled AutomationRule across
  // every tenant in one sweep. Every query inside the loop below re-scopes by rule.tenantId.
  const rules = await withCrossTenantAccess(() => prisma.automationRule.findMany({ where: { enabled: true } }));
  const results = [];

  for (const rule of rules) {
    try {
      // RLS real: runRule já roda com o contexto de tenant da regra (ver config/tenantGuard.ts).
      const result = await runRule(prisma, rule);
      results.push({ ruleId: rule.id, trigger: rule.trigger, ...result });
    } catch (e: any) {
      console.error(`[automationEngine] Falha ao avaliar regra ${rule.id} (${rule.trigger}):`, e);
      await runWithTenantContextAsync(rule.tenantId, async () => {
        await notify(prisma, {
          tenantId: rule.tenantId,
          type: "AUTOMATION_ERROR",
          severity: "ERRO",
          message: `Falha ao avaliar a regra "${rule.name}": ${e.message}`,
          relatedType: "AutomationRule",
          relatedId: rule.id,
        });
      });
    }
  }

  return results;
}

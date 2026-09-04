import { AppPrismaClient } from "../config/db";
import { logAudit } from "../middleware/audit";
import { notify } from "./notifications";
import { enqueueCampaign, processQueueBatch } from "./campaignQueue";
import { runWithTenantContextAsync, withCrossTenantAccess } from "../config/tenantGuard";

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
}

async function matchClients(prisma: AppPrismaClient, tenantId: string, trigger: string, condition: any): Promise<MatchResult> {
  switch (trigger) {
    case "NOVO_CLIENTE_SEM_USO": {
      const dias = condition?.diasDesdeCadastro ?? 7;
      const cutoff = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);
      const clients = await prisma.client.findMany({
        where: {
          tenantId,
          faixaUso: "NAO_UTILIZOU",
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

async function executeAction(prisma: AppPrismaClient, tenantId: string, ruleId: string, ruleName: string, action: any, clientIds: string[]) {
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
      message: action.message || `Regra "${ruleName}" identificou ${clientIds.length} cliente(s) elegível(is).`,
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

    const campaign = await prisma.campaign.create({
      data: {
        tenantId,
        name: `Automação: ${ruleName} (${new Date().toISOString().slice(0, 10)})`,
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
    await processQueueBatch(prisma, campaign.id, Math.min(500, enqueueResult.queued));

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

export async function evaluateAutomationRules(prisma: AppPrismaClient) {
  // Genuinely cross-tenant by design: this is the periodic scheduler entry point (see
  // services/scheduler.ts runAutomationJob) that evaluates every enabled AutomationRule across
  // every tenant in one sweep. Every query inside the loop below re-scopes by rule.tenantId.
  const rules = await withCrossTenantAccess(() => prisma.automationRule.findMany({ where: { enabled: true } }));
  const results = [];

  for (const rule of rules) {
    try {
      // RLS real: a partir daqui já sabemos o tenant desta regra — resto do trabalho roda com o
      // contexto de tenant setado (ver config/tenantGuard.ts).
      const result = await runWithTenantContextAsync(rule.tenantId, async () => {
        const { clientIds } = await matchClients(prisma, rule.tenantId, rule.trigger, rule.condition);
        const actionResult = await executeAction(prisma, rule.tenantId, rule.id, rule.name, rule.action, clientIds);
        await prisma.automationRule.update({ where: { id: rule.id }, data: { lastRunAt: new Date() } });
        return { matched: clientIds.length, ...actionResult };
      });
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

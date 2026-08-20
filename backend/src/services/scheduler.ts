import cron from "node-cron";
import { prisma } from "../config/db";
import { runImport } from "./importService";
import { DEFAULT_COLUMN_MAPPING, fetchSheetRows } from "./googleSheets";
import { notify } from "./notifications";
import { buildSegmentWhere } from "./segments";
import { evaluateAutomationRules } from "./automationEngine";
import { processQueueBatch } from "./campaignQueue";
import { runRetentionSweep } from "./retention";

/**
 * Orquestra os jobs periódicos do backend. Cada responsabilidade roda no seu próprio
 * cron.schedule para poder ter uma cadência independente (sync de planilha é configurável por
 * tenant; dispatch/automação precisam rodar com frequência; retenção roda uma vez por dia).
 */
export function startScheduler() {
  startSheetSyncJob();
  startSegmentRefreshJob();
  startAutomationJob();
  startCampaignDispatchSweep();
  startRetentionJob();
}

/** Sincronização automática do Google Sheets (PRD — Must have), respeitando o cron por tenant. */
function startSheetSyncJob() {
  cron.schedule("* * * * *", async () => {
    const connections = await prisma.sheetConnection.findMany({ where: { active: true } });
    const now = new Date();

    for (const conn of connections) {
      if (!cronMatchesNow(conn.cronSchedule, now)) continue;
      try {
        const rows = await fetchSheetRows(conn.sheetId, conn.sheetRange, (conn.columnMapping as any) || DEFAULT_COLUMN_MAPPING);
        await runImport(prisma, conn.tenantId, rows, "scheduler", "google_sheets", conn.sheetId);
        await prisma.sheetConnection.update({ where: { id: conn.id }, data: { lastSyncAt: now } });
      } catch (e: any) {
        // Falhas de sincronização automática ficam registradas no ImportJob (status FALHOU)
        // quando o erro ocorre durante o processamento das linhas; falhas de conexão (antes de
        // existir um job) são notificadas diretamente aqui.
        console.error(`[scheduler] Falha ao sincronizar SheetConnection ${conn.id}:`, e);
        await notify(prisma, {
          tenantId: conn.tenantId,
          type: "IMPORT_FAILED",
          severity: "ERRO",
          message: `Sincronização automática da planilha ${conn.sheetId} falhou: ${e.message}`,
        });
      }
    }
  });
}

/** Recontagem periódica de segmentos dinâmicos (Fase 2), cada um no seu próprio refreshCron. */
function startSegmentRefreshJob() {
  cron.schedule("* * * * *", async () => {
    const segments = await prisma.segmentDefinition.findMany({ where: { dynamic: true } });
    const now = new Date();

    for (const segment of segments) {
      if (!cronMatchesNow(segment.refreshCron, now)) continue;
      try {
        const where = buildSegmentWhere(segment.tenantId, segment.filters as any);
        const count = await prisma.client.count({ where });
        await prisma.segmentDefinition.update({
          where: { id: segment.id },
          data: { lastCount: count, lastRefreshedAt: now },
        });
      } catch (e) {
        console.error(`[scheduler] Falha ao atualizar segmento dinâmico ${segment.id}:`, e);
      }
    }
  });
}

/** Motor de automação (Fase 2) — avalia gatilhos e dispara ações a cada 5 minutos. */
function startAutomationJob() {
  cron.schedule("*/5 * * * *", async () => {
    try {
      await evaluateAutomationRules(prisma);
    } catch (e) {
      console.error("[scheduler] Falha ao avaliar automações:", e);
    }
  });
}

/**
 * Drena campanhas AGENDADA/EM_EXECUCAO que ainda têm mensagens em FILA — cobre tanto campanhas
 * criadas manualmente (wizard) quanto as disparadas pelo motor de automação, respeitando sempre
 * o throttle da campanha e o rate limit global do tenant.
 */
function startCampaignDispatchSweep() {
  cron.schedule("* * * * *", async () => {
    const pendingCampaigns = await prisma.campaign.findMany({
      where: { status: { in: ["AGENDADA", "EM_EXECUCAO"] } },
      select: { id: true },
    });

    for (const c of pendingCampaigns) {
      try {
        await processQueueBatch(prisma, c.id, 100);
      } catch (e) {
        console.error(`[scheduler] Falha ao processar fila da campanha ${c.id}:`, e);
      }
    }
  });
}

/** Política de retenção/anonimização (LGPD) — roda uma vez por dia. */
function startRetentionJob() {
  cron.schedule("0 3 * * *", async () => {
    try {
      const result = await runRetentionSweep(prisma);
      if (result.totalAnonymized > 0) {
        console.log(`[scheduler] Retenção: ${result.totalAnonymized} cliente(s) anonimizado(s).`);
      }
    } catch (e) {
      console.error("[scheduler] Falha no job de retenção:", e);
    }
  });
}

function cronMatchesNow(expr: string, date: Date): boolean {
  // Comparação simples campo a campo (minuto hora dia-mês mês dia-semana) — sem libs extras.
  const [min, hour, dom, month, dow] = expr.split(" ");
  const matches = (field: string, value: number) => field === "*" || field.split(",").map(Number).includes(value);
  return (
    matches(min, date.getMinutes()) &&
    matches(hour, date.getHours()) &&
    matches(dom, date.getDate()) &&
    matches(month, date.getMonth() + 1) &&
    matches(dow, date.getDay())
  );
}

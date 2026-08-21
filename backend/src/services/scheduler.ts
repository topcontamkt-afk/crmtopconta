import cron from "node-cron";
import { prisma } from "../config/db";
import { runImport } from "./importService";
import { DEFAULT_COLUMN_MAPPING, fetchSheetRows } from "./googleSheets";
import { notify } from "./notifications";
import { buildSegmentWhere } from "./segments";
import { evaluateAutomationRules } from "./automationEngine";
import { processQueueBatch } from "./campaignQueue";
import { runRetentionSweep } from "./retention";
import { exportAllTenantsSummary } from "./biExport";
import { withCrossTenantAccess } from "../config/tenantGuard";

/**
 * Cada função abaixo é o "corpo" de um job periódico, desacoplada de *como* ela é disparada:
 *  - localmente (dev/servidor de longa duração), `startScheduler()` as agenda com node-cron
 *    rodando em processo, a cada minuto;
 *  - em produção serverless (Vercel), os mesmos jobs são expostos como endpoints HTTP
 *    (`/api/cron/*`, ver routes/cron.ts) disparados por Vercel Cron Jobs, já que uma função
 *    serverless não mantém um loop `node-cron` vivo entre invocações.
 */

/** Sincronização automática do Google Sheets (PRD — Must have), respeitando o cron por tenant. */
export async function runSheetSyncJob() {
  // Genuinely cross-tenant by design: sweeps every tenant's active SheetConnection to check
  // whose cron is due right now. Each row is re-scoped to its own tenant below (conn.tenantId).
  const connections = await withCrossTenantAccess(() =>
    prisma.sheetConnection.findMany({ where: { active: true } })
  );
  const now = new Date();
  let synced = 0;

  for (const conn of connections) {
    if (!cronMatchesNow(conn.cronSchedule, now)) continue;
    try {
      const rows = await fetchSheetRows(conn.sheetId, conn.sheetRange, (conn.columnMapping as any) || DEFAULT_COLUMN_MAPPING);
      await runImport(prisma, conn.tenantId, rows, "scheduler", "google_sheets", conn.sheetId);
      await prisma.sheetConnection.update({ where: { id: conn.id }, data: { lastSyncAt: now } });
      synced++;
    } catch (e: any) {
      console.error(`[scheduler] Falha ao sincronizar SheetConnection ${conn.id}:`, e);
      await notify(prisma, {
        tenantId: conn.tenantId,
        type: "IMPORT_FAILED",
        severity: "ERRO",
        message: `Sincronização automática da planilha ${conn.sheetId} falhou: ${e.message}`,
      });
    }
  }
  return { checked: connections.length, synced };
}

/** Recontagem periódica de segmentos dinâmicos (Fase 2), cada um no seu próprio refreshCron. */
export async function runSegmentRefreshJob() {
  // Genuinely cross-tenant by design: sweeps every tenant's dynamic segments to check whose
  // refreshCron is due right now. Each row is re-scoped via buildSegmentWhere(segment.tenantId).
  const segments = await withCrossTenantAccess(() =>
    prisma.segmentDefinition.findMany({ where: { dynamic: true } })
  );
  const now = new Date();
  let refreshed = 0;

  for (const segment of segments) {
    if (!cronMatchesNow(segment.refreshCron, now)) continue;
    try {
      const where = buildSegmentWhere(segment.tenantId, segment.filters as any);
      const count = await prisma.client.count({ where });
      await prisma.segmentDefinition.update({
        where: { id: segment.id },
        data: { lastCount: count, lastRefreshedAt: now },
      });
      refreshed++;
    } catch (e) {
      console.error(`[scheduler] Falha ao atualizar segmento dinâmico ${segment.id}:`, e);
    }
  }
  return { checked: segments.length, refreshed };
}

/** Motor de automação (Fase 2) — avalia gatilhos e dispara ações. */
export async function runAutomationJob() {
  return evaluateAutomationRules(prisma);
}

/**
 * Drena campanhas AGENDADA/EM_EXECUCAO que ainda têm mensagens em FILA — cobre tanto campanhas
 * criadas manualmente (wizard) quanto as disparadas pelo motor de automação, respeitando sempre
 * o throttle da campanha e o rate limit global do tenant.
 */
export async function runCampaignDispatchJob() {
  // Genuinely cross-tenant by design: sweeps every tenant's in-flight campaigns to drain queued
  // messages. processQueueBatch() re-derives and re-scopes by the campaign's own tenantId.
  const pendingCampaigns = await withCrossTenantAccess(() =>
    prisma.campaign.findMany({
      where: { status: { in: ["AGENDADA", "EM_EXECUCAO"] } },
      select: { id: true },
    })
  );

  const results = [];
  for (const c of pendingCampaigns) {
    try {
      results.push({ campaignId: c.id, ...(await processQueueBatch(prisma, c.id, 100)) });
    } catch (e) {
      console.error(`[scheduler] Falha ao processar fila da campanha ${c.id}:`, e);
    }
  }
  return { checked: pendingCampaigns.length, results };
}

/** Política de retenção/anonimização (LGPD) — normalmente 1x/dia. */
export async function runRetentionJob() {
  return runRetentionSweep(prisma);
}

/** Conector BI leve (Fase 3) — escreve o resumo diário na planilha de cada tenant conectado. */
export async function runBiExportJob() {
  return exportAllTenantsSummary(prisma);
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

/**
 * Orquestra os jobs periódicos via node-cron, em processo — usado apenas no servidor de longa
 * duração (dev local ou um host tipo Railway/Render). Em serverless (Vercel), NÃO é chamada;
 * os mesmos jobs rodam via Vercel Cron Jobs batendo em /api/cron/* (ver routes/cron.ts).
 */
export function startScheduler() {
  cron.schedule("* * * * *", () => runSheetSyncJob().catch((e) => console.error("[scheduler] sheet-sync:", e)));
  cron.schedule("* * * * *", () => runSegmentRefreshJob().catch((e) => console.error("[scheduler] segments-refresh:", e)));
  cron.schedule("*/5 * * * *", () => runAutomationJob().catch((e) => console.error("[scheduler] automations:", e)));
  cron.schedule("* * * * *", () => runCampaignDispatchJob().catch((e) => console.error("[scheduler] dispatch:", e)));
  cron.schedule("0 3 * * *", () => runRetentionJob().catch((e) => console.error("[scheduler] retention:", e)));
  cron.schedule("0 4 * * *", () => runBiExportJob().catch((e) => console.error("[scheduler] bi-export:", e)));
}

import {
  runAutomationJob,
  runBiExportJob,
  runCampaignDispatchJob,
  runRetentionJob,
  runSegmentRefreshJob,
  runSheetSyncJob,
  runSnapshotJobEntry,
} from "./scheduler";

/**
 * Cron Triggers do Worker (`scheduled()` em worker/index.ts). O plano grátis dá 5 triggers para a CONTA inteira
 * (compartilhada), então os 7 jobs diários do antigo `vercel.json` cabem em 3, nos mesmos horários (UTC):
 *
 * | Trigger       | Jobs, em ordem                                                        |
 * |---------------|-----------------------------------------------------------------------|
 * | `0 3 * * *`   | retenção (era 03:00), BI (era 04:00)                                  |
 * | `0 6 * * *`   | sync da planilha (06:00), foto do dashboard (06:30, depende do sync)  |
 * | `0 9-11 * * *`| 9h disparo, 10h automações, 11h segmentos dinâmicos (um por hora)     |
 *
 * No Workers Paid (250 triggers por conta) voltam as cadências do servidor local (src/index.ts), em 4 triggers:
 *
 * | Trigger       | Jobs                                                                   |
 * |---------------|------------------------------------------------------------------------|
 * | `* * * * *`   | disparo, sync da planilha, segmentos dinâmicos (os dois últimos só     |
 * |               | fazem algo no minuto do cron de cada tenant)                           |
 * | `*\/5 * * * *` | automações                                                           |
 * | `0 3 * * *`   | retenção, BI (o mesmo do grátis)                                       |
 * | `30 6 * * *`  | foto do dashboard                                                      |
 *
 * O código entende os dois conjuntos; trocar de plano é só trocar `triggers.crons` no wrangler.jsonc
 * (cronTriggers.test.ts confere que cada ambiente usa um deles por inteiro).
 *
 * Os mesmos jobs seguem disponíveis em `/api/cron/*` (CRON_SECRET) para rodar à mão.
 */
export type CronJob = "retention" | "bi-export" | "sheet-sync" | "snapshot" | "dispatch" | "automations" | "segments-refresh";

export const CRON_TRIGGERS = ["0 3 * * *", "0 6 * * *", "0 9-11 * * *"] as const;
/** Triggers para o Workers Paid (ver a tabela acima). */
export const CRON_TRIGGERS_PAGO = ["* * * * *", "*/5 * * * *", "0 3 * * *", "30 6 * * *"] as const;

const RUN: Record<CronJob, (now: Date) => Promise<unknown>> = {
  retention: () => runRetentionJob(),
  "bi-export": () => runBiExportJob(),
  "sheet-sync": (now) => runSheetSyncJob(now),
  snapshot: () => runSnapshotJobEntry(),
  dispatch: () => runCampaignDispatchJob(),
  automations: () => runAutomationJob(),
  "segments-refresh": (now) => runSegmentRefreshJob(now),
};

const POR_HORA: Record<number, CronJob> = { 9: "dispatch", 10: "automations", 11: "segments-refresh" };

/** Jobs de um disparo do trigger `cron`, no horário agendado (UTC). Trigger desconhecido não roda nada. */
export function jobsDoTrigger(cron: string, agendado: Date): CronJob[] {
  switch (cron) {
    case "0 3 * * *":
      return ["retention", "bi-export"];
    case "0 6 * * *":
      return ["sheet-sync", "snapshot"];
    case "0 9-11 * * *": {
      const job = POR_HORA[agendado.getUTCHours()];
      return job ? [job] : [];
    }
    case "* * * * *":
      return ["dispatch", "sheet-sync", "segments-refresh"];
    case "*/5 * * * *":
      return ["automations"];
    case "30 6 * * *":
      return ["snapshot"];
    default:
      return [];
  }
}

export interface CronJobResult {
  job: CronJob;
  ok: boolean;
  ms: number;
  result?: unknown;
  error?: string;
}

/**
 * Roda os jobs do trigger em sequência; a falha de um não impede os seguintes (cada job já é cross-tenant e
 * trata o erro de cada tenant). O horário agendado vai para os jobs que comparam o cron de cada tenant, para
 * não depender de quantos segundos o disparo atrasou.
 */
export async function runCronTrigger(cron: string, agendado: Date, run: Record<CronJob, (now: Date) => Promise<unknown>> = RUN): Promise<CronJobResult[]> {
  const jobs = jobsDoTrigger(cron, agendado);
  if (!jobs.length) console.warn(`[cron] trigger sem job: "${cron}" às ${agendado.toISOString()}`);
  const out: CronJobResult[] = [];
  for (const job of jobs) {
    const inicio = Date.now();
    try {
      const result = await run[job](agendado);
      out.push({ job, ok: true, ms: Date.now() - inicio, result });
      console.log(`[cron] ${job} ok em ${Date.now() - inicio} ms`);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      out.push({ job, ok: false, ms: Date.now() - inicio, error });
      console.error(`[cron] ${job} falhou:`, e);
    }
  }
  return out;
}

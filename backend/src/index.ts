import "dotenv/config";
import app from "./app";
import cron from "node-cron";
import {
  runAutomationJob,
  runBiExportJob,
  runCampaignDispatchJob,
  runRetentionJob,
  runSegmentRefreshJob,
  runSheetSyncJob,
  runSnapshotJobEntry,
} from "./services/scheduler";

/**
 * Entrypoint do servidor de longa duração (dev local, ou hospedagem tipo Railway/Render).
 * Em produção serverless (Vercel) este arquivo NÃO é usado — a função em api/index.ts importa
 * ./app diretamente, e os jobs periódicos rodam via Vercel Cron Jobs (routes/cron.ts) em vez
 * do node-cron em processo iniciado aqui.
 */
/**
 * Orquestra os jobs periódicos via node-cron, em processo — usado apenas neste servidor de longa
 * duração. Fica aqui, e não em services/scheduler.ts, porque o node-cron não carrega no Worker
 * (lá os jobs rodam pelo `scheduled()` do Worker, ver routes/cron.ts).
 */
function startScheduler() {
  cron.schedule("* * * * *", () => runSheetSyncJob().catch((e) => console.error("[scheduler] sheet-sync:", e)));
  cron.schedule("* * * * *", () => runSegmentRefreshJob().catch((e) => console.error("[scheduler] segments-refresh:", e)));
  cron.schedule("*/5 * * * *", () => runAutomationJob().catch((e) => console.error("[scheduler] automations:", e)));
  cron.schedule("* * * * *", () => runCampaignDispatchJob().catch((e) => console.error("[scheduler] dispatch:", e)));
  cron.schedule("0 3 * * *", () => runRetentionJob().catch((e) => console.error("[scheduler] retention:", e)));
  cron.schedule("30 6 * * *", () => runSnapshotJobEntry().catch((e) => console.error("[scheduler] snapshot:", e)));
  cron.schedule("0 4 * * *", () => runBiExportJob().catch((e) => console.error("[scheduler] bi-export:", e)));
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`CRM TopConta API rodando na porta ${PORT}`);
  if (process.env.ENABLE_SCHEDULER !== "false") {
    startScheduler();
  }
});

import { Router } from "express";
import { requireCronSecret } from "../middleware/cronAuth";
import {
  runAutomationJob,
  runBiExportJob,
  runCampaignDispatchJob,
  runRetentionJob,
  runSegmentRefreshJob,
  runSheetSyncJob,
} from "../services/scheduler";

/**
 * Equivalente HTTP do scheduler em-processo (node-cron), para rodar como serverless (Vercel).
 * Cada rota é disparada por um "Vercel Cron Job" configurado em vercel.json — ver esse arquivo
 * para a periodicidade de cada uma. Protegidas por CRON_SECRET (middleware requireCronSecret).
 *
 * Vercel Cron Jobs sempre chamam com método GET (e, se a env var se chamar exatamente
 * CRON_SECRET, a própria Vercel já envia "Authorization: Bearer $CRON_SECRET" automaticamente).
 * Aceitamos GET e POST para também permitir disparo manual (curl, outro agendador externo).
 */
const router = Router();
router.use(requireCronSecret);

router.all("/sheet-sync", async (_req, res) => {
  res.json(await runSheetSyncJob());
});

router.all("/segments-refresh", async (_req, res) => {
  res.json(await runSegmentRefreshJob());
});

router.all("/automations", async (_req, res) => {
  res.json(await runAutomationJob());
});

router.all("/dispatch", async (_req, res) => {
  res.json(await runCampaignDispatchJob());
});

router.all("/retention", async (_req, res) => {
  res.json(await runRetentionJob());
});

router.all("/bi-export", async (_req, res) => {
  res.json(await runBiExportJob());
});

export default router;

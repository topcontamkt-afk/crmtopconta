import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../middleware/audit";
import { runImport, RawSheetRow } from "../services/importService";
import { DEFAULT_COLUMN_MAPPING, fetchSheetRows } from "../services/googleSheets";

const router = Router();
router.use(requireAuth);

router.get("/", async (req, res) => {
  const jobs = await prisma.importJob.findMany({
    where: { tenantId: req.user!.tenantId },
    orderBy: { startedAt: "desc" },
    take: 50,
  });
  res.json(jobs);
});

router.get("/:id", async (req, res) => {
  const job = await prisma.importJob.findFirst({ where: { id: req.params.id, tenantId: req.user!.tenantId } });
  if (!job) return res.status(404).json({ error: "Importação não encontrada" });
  res.json(job);
});

/** POST /api/imports/google-sheets — trigger manual de sincronização (a automática roda via cron/scheduler). */
const sheetsSchema = z.object({
  sheetId: z.string(),
  range: z.string().default("A1:Z"),
  columnMapping: z.record(z.string()).optional(),
});

router.post("/google-sheets", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const parsed = sheetsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: userId } = req.user!;
  const { sheetId, range, columnMapping } = parsed.data;

  try {
    const rows = await fetchSheetRows(sheetId, range, columnMapping || DEFAULT_COLUMN_MAPPING);
    const { importJobId, result } = await runImport(prisma, tenantId, rows, userId, "google_sheets", sheetId);
    await logAudit({ tenantId, userId, action: "IMPORT_GOOGLE_SHEETS", target: "ImportJob", targetId: importJobId, details: result });
    res.json({ importJobId, ...result });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/imports/csv — importação via linhas já parseadas no cliente (fallback ao Sheets). */
const csvSchema = z.object({
  rows: z.array(z.record(z.any())).min(1),
});

router.post("/csv", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const parsed = csvSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: userId } = req.user!;

  const { importJobId, result } = await runImport(
    prisma,
    tenantId,
    parsed.data.rows as RawSheetRow[],
    userId,
    "csv"
  );
  await logAudit({ tenantId, userId, action: "IMPORT_CSV", target: "ImportJob", targetId: importJobId, details: result });
  res.json({ importJobId, ...result });
});

export default router;

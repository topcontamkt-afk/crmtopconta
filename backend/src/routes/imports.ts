import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../middleware/audit";
import { runImport, RawSheetRow } from "../services/importService";
import { runCardAccountImport, CardAccountRow } from "../services/cardAccountImport";
import { DEFAULT_COLUMN_MAPPING, fetchSheetRows } from "../services/googleSheets";
import { notify } from "../services/notifications";

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

/**
 * GET /api/imports/quality — painel de qualidade de base (Fase 2 — Should have):
 * registros incompletos, erros recentes de importação e resumo por motivo de erro.
 * Precisa vir antes de "/:id" para não ser capturada como um id de ImportJob.
 */
router.get("/quality", async (req, res) => {
  const { tenantId } = req.user!;
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [semCidade, semDataCadastro, semDataAbertura, totalClientes, recentJobs] = await Promise.all([
    prisma.client.count({ where: { tenantId, cidade: null } }),
    prisma.client.count({ where: { tenantId, dataCadastro: null } }),
    prisma.client.count({ where: { tenantId, dataAberturaConta: null } }),
    prisma.client.count({ where: { tenantId } }),
    prisma.importJob.findMany({
      where: { tenantId, startedAt: { gte: since } },
      orderBy: { startedAt: "desc" },
      take: 20,
    }),
  ]);

  // Agrupa os motivos de erro mais recorrentes entre as últimas importações, para o
  // operador priorizar a correção da planilha de origem.
  const motivoCount: Record<string, number> = {};
  for (const job of recentJobs) {
    for (const err of (job.errors as any[]) || []) {
      const motivoBase = String(err.motivo).split(":")[0];
      motivoCount[motivoBase] = (motivoCount[motivoBase] || 0) + 1;
    }
  }

  res.json({
    totalClientes,
    registrosIncompletos: {
      semCidade,
      semDataCadastro,
      semDataAberturaConta: semDataAbertura,
    },
    importacoesUltimos30Dias: recentJobs.length,
    importacoesComErro: recentJobs.filter((j) => j.errorCount > 0).length,
    motivosDeErroMaisComuns: Object.entries(motivoCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([motivo, count]) => ({ motivo, count })),
  });
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
    // Falha antes mesmo de criar o ImportJob (ex.: credencial/planilha inválida) — não há
    // job para carregar o status FALHOU, então a notificação é o único rastro operacional.
    await notify(prisma, {
      tenantId,
      type: "IMPORT_FAILED",
      severity: "ERRO",
      message: `Não foi possível conectar à planilha ${sheetId}: ${e.message}`,
    });
    res.status(500).json({ error: e.message });
  }
});

const fixErrorsSchema = z.object({
  rows: z.array(z.record(z.any())).min(1),
});

/**
 * POST /api/imports/:id/fix-errors — correção em massa de erros de importação (Fase 2):
 * reenvia apenas as linhas corrigidas (tipicamente as que constam em ImportJob.errors) pelo
 * mesmo pipeline de validação/dedupe, gerando um novo ImportJob de correção.
 */
router.post("/:id/fix-errors", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const parsed = fixErrorsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: userId } = req.user!;

  const originalJob = await prisma.importJob.findFirst({ where: { id: req.params.id, tenantId } });
  if (!originalJob) return res.status(404).json({ error: "Importação original não encontrada" });

  const { importJobId, result } = await runImport(
    prisma,
    tenantId,
    parsed.data.rows as RawSheetRow[],
    userId,
    "csv"
  );
  await logAudit({
    tenantId,
    userId,
    action: "FIX_IMPORT_ERRORS",
    target: "ImportJob",
    targetId: importJobId,
    details: { originalImportJobId: originalJob.id, ...result },
  });
  res.json({ importJobId, correctedFrom: originalJob.id, ...result });
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

/**
 * POST /api/imports/cartoes — upload direto de arquivo (CSV) no formato real de "Cartões e
 * contas" (cadastro/ativação de cartão vinculado a convênio). O mapeamento cabeçalho da
 * planilha -> campo canônico é feito no frontend (tela de upload); aqui as linhas já chegam
 * no formato de CardAccountRow. Ver services/cardAccountImport.ts.
 */
const cardAccountSchema = z.object({
  rows: z.array(z.record(z.any())).min(1),
});

router.post("/cartoes", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const parsed = cardAccountSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: userId } = req.user!;

  const { importJobId, result } = await runCardAccountImport(
    prisma,
    tenantId,
    parsed.data.rows as CardAccountRow[],
    userId
  );
  await logAudit({ tenantId, userId, action: "IMPORT_CARTOES_CONTAS", target: "ImportJob", targetId: importJobId, details: result });
  res.json({ importJobId, ...result });
});

export default router;

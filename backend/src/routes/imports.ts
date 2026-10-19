import { refreshCicloColumns } from "../services/cicloRefresh";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { ACOES_ACESSO_INDEVIDO, logAudit, logTentativaAcesso } from "../middleware/audit";
import { runImport, RawSheetRow } from "../services/importService";
import { runCardAccountImport, previewCardAccountImport, CardAccountRow, FieldPresence } from "../services/cardAccountImport";
import { formatMismatch, FORMAT_LABEL, ImportFormat } from "../services/importFormat";
import { assertUndoable, groupLotes, undoLoteBatch, UndoError } from "../services/importUndo";
import { DEFAULT_COLUMN_MAPPING, fetchSheetRows, resolveTenantSheet, serviceAccountEmail, SheetAccessError } from "../services/googleSheets";
import { notify } from "../services/notifications";
import { importLimiter } from "../middleware/rateLimit";

const router = Router();

/** Cidade nova na planilha pode já ter ciclo cadastrado: refaz o dia de abertura dos clientes (nunca derruba a importação). */
async function refreshCiclos(tenantId: string) {
  await refreshCicloColumns(tenantId).catch((e) => console.error("[imports] ciclos:", e));
}
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


/** Campos extras que a tela manda em toda requisição de um arquivo (proteção da importação). */
const protecaoSchema = {
  cabecalhos: z.array(z.string()).max(300).optional(), // cabeçalhos originais do arquivo (confere o formato)
  loteId: z.string().uuid().optional(), // todas as requisições de UM arquivo compartilham
  nomeArquivo: z.string().max(200).optional(),
  forcarFormato: z.boolean().optional(), // só ADMIN: segue mesmo com o formato aparentemente errado
};

/** Segunda trava (a primeira é na tela): barra o arquivo cujo formato claramente não é o escolhido. */
function barrarFormatoErrado(req: any, res: any, escolhido: ImportFormat, cabecalhos?: string[], forcar?: boolean): boolean {
  if (!cabecalhos || cabecalhos.length === 0) return false;
  const erro = formatMismatch(escolhido, cabecalhos);
  if (!erro) return false;
  if (forcar && req.user?.role === "ADMIN") return false;
  res.status(422).json({ error: erro.mensagem, codigo: "FORMATO_INCOMPATIVEL", detectado: erro.detectado, escolhido });
  return true;
}

/**
 * GET /api/imports/lotes — histórico por ARQUIVO (cada arquivo vira várias requisições de 400 linhas),
 * com o formato usado e se ainda dá para desfazer (só a última importação de clientes).
 */
router.get("/lotes", async (req, res) => {
  const { tenantId } = req.user!;
  const jobs = await prisma.importJob.findMany({ where: { tenantId }, orderBy: { startedAt: "desc" }, take: 400 });
  const lotes = groupLotes(jobs).slice(0, 30);
  // "Desfazer" só na última importação de clientes que ainda não foi desfeita e ainda tem estado anterior.
  const candidata = lotes.find((l) => !l.desfeita && l.formato && ["cartoes", "generico"].includes(l.formato));
  let podeDesfazer: string | null = null;
  if (candidata) {
    try {
      await assertUndoable(prisma, tenantId, candidata.loteId);
      podeDesfazer = candidata.loteId;
    } catch {
      podeDesfazer = null;
    }
  }
  res.json(
    lotes.map((l) => ({
      ...l,
      formatoNome: l.formato ? FORMAT_LABEL[l.formato as keyof typeof FORMAT_LABEL] ?? l.formato : null,
      podeDesfazer: l.loteId === podeDesfazer,
    }))
  );
});

/** GET /api/imports/lotes/:loteId — erros de todas as requisições do arquivo (até 200). */
router.get("/lotes/:loteId", async (req, res) => {
  const { tenantId } = req.user!;
  const key = req.params.loteId;
  let jobs = await prisma.importJob.findMany({ where: { tenantId, loteId: key }, orderBy: { startedAt: "asc" } });
  if (jobs.length === 0) jobs = await prisma.importJob.findMany({ where: { tenantId, id: key } });
  if (jobs.length === 0) return res.status(404).json({ error: "Importação não encontrada" });
  const errors = jobs.flatMap((j) => ((j.errors as any[]) ?? [])).slice(0, 200);
  res.json({ loteId: key, errors });
});

/**
 * POST /api/imports/lotes/:loteId/desfazer — volta os clientes ao estado de antes da importação. Processa
 * em partes (a tela repete até `concluido`). Só ADMIN, só a última importação de clientes.
 */
router.post("/lotes/:loteId/desfazer", requireRole("ADMIN"), async (req, res) => {
  const { tenantId, id: userId } = req.user!;
  try {
    const r = await undoLoteBatch(prisma, tenantId, userId, req.params.loteId);
    if (r.concluido || r.restaurados + r.removidos + r.mantidos + r.ausentes > 0) {
      await logAudit({ tenantId, userId, action: r.concluido ? "UNDO_IMPORT" : "UNDO_IMPORT_PARTIAL", target: "ImportJob", targetId: req.params.loteId, details: r });
    }
    res.json(r);
  } catch (e) {
    if (e instanceof UndoError) return res.status(e.status).json({ error: e.message, codigo: e.codigo });
    throw e;
  }
});

router.get("/:id", async (req, res) => {
  const job = await prisma.importJob.findFirst({ where: { id: req.params.id, tenantId: req.user!.tenantId } });
  if (!job) return res.status(404).json({ error: "Importação não encontrada" });
  res.json(job);
});

/**
 * POST /api/imports/google-sheets — trigger manual de sincronização (a automática roda via cron/scheduler).
 * LGPD 06-02: só lê a planilha CADASTRADA do próprio tenant (SheetConnection, criada por ADMIN em
 * Integrações). `sheetId` no corpo é opcional e, se vier, precisa ser o da planilha cadastrada; um
 * sheetId qualquer não é mais aceito, mesmo que a planilha esteja compartilhada com a Service Account.
 */
const sheetsSchema = z.object({
  sheetId: z.string().max(300).optional(),
  range: z.string().max(100).optional(),
  columnMapping: z.record(z.string()).optional(),
});

router.post("/google-sheets", importLimiter, requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const parsed = sheetsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: userId } = req.user!;
  const contaServico = serviceAccountEmail();

  let conn;
  try {
    conn = await resolveTenantSheet(prisma, tenantId, parsed.data.sheetId);
  } catch (e) {
    if (!(e instanceof SheetAccessError)) throw e;
    // LGPD 05-03/06-02: tentativa de ler planilha não cadastrada (ou de outro controlador) fica no AuditLog.
    await logTentativaAcesso({
      tenantId,
      userId,
      action: ACOES_ACESSO_INDEVIDO.IMPORTACAO_PLANILHA_NEGADA,
      details: { codigo: e.codigo, sheetIdPedido: parsed.data.sheetId ?? null },
    });
    return res.status(e.status).json({ error: e.message, codigo: e.codigo, serviceAccountEmail: contaServico });
  }
  const sheetId = conn.sheetId;
  const range = parsed.data.range || conn.sheetRange;
  const columnMapping = parsed.data.columnMapping || (conn.columnMapping as Record<string, string> | null) || DEFAULT_COLUMN_MAPPING;

  try {
    const rows = await fetchSheetRows(sheetId, range, columnMapping);
    const { importJobId, result } = await runImport(prisma, tenantId, rows, userId, "google_sheets", sheetId);
    await logAudit({ tenantId, userId, action: "IMPORT_GOOGLE_SHEETS", target: "ImportJob", targetId: importJobId, details: result });
    await refreshCiclos(tenantId);
    // LGPD 06-02: devolve com qual Service Account a planilha precisa estar compartilhada (só leitura basta para importar).
    res.json({ importJobId, ...result, serviceAccountEmail: contaServico });
  } catch (e: any) {
    // Detalhe completo do erro só vai para o log do servidor e para a notificação interna do
    // tenant (abaixo) — nunca é devolvido ao chamador HTTP, para não vazar internals do
    // Prisma/Google Sheets API. Ver o mesmo padrão no error handler global de app.ts.
    console.error(e);
    // Falha antes mesmo de criar o ImportJob (ex.: credencial/planilha inválida) — não há
    // job para carregar o status FALHOU, então a notificação é o único rastro operacional.
    await notify(prisma, {
      tenantId,
      type: "IMPORT_FAILED",
      severity: "ERRO",
      message: `Não foi possível conectar à planilha ${sheetId}: ${e.message}`,
    });
    res.status(500).json({ error: "Erro interno do servidor" });
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
router.post("/:id/fix-errors", importLimiter, requireRole("ADMIN", "OPERATOR"), async (req, res) => {
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
  await refreshCiclos(tenantId);
  res.json({ importJobId, correctedFrom: originalJob.id, ...result });
});

/** POST /api/imports/csv — importação via linhas já parseadas no cliente (fallback ao Sheets). */
const csvSchema = z.object({
  rows: z.array(z.record(z.any())).min(1),
  camposPresentes: z.array(z.string()).max(40).optional(), // campos que o ARQUIVO INTEIRO traz com valor
  ...protecaoSchema,
});

router.post("/csv", importLimiter, requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const parsed = csvSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: userId } = req.user!;
  if (barrarFormatoErrado(req, res, "generico", parsed.data.cabecalhos, parsed.data.forcarFormato)) return;

  const { importJobId, result } = await runImport(
    prisma,
    tenantId,
    parsed.data.rows as RawSheetRow[],
    userId,
    "csv",
    undefined,
    { camposPresentes: parsed.data.camposPresentes, loteId: parsed.data.loteId, nomeArquivo: parsed.data.nomeArquivo }
  );
  await logAudit({ tenantId, userId, action: "IMPORT_CSV", target: "ImportJob", targetId: importJobId, details: result });
  await refreshCiclos(tenantId);
  res.json({ importJobId, ...result });
});

/**
 * POST /api/imports/cartoes — upload direto de arquivo (CSV) no formato real de "Cartões e
 * contas" (cadastro/ativação de cartão vinculado a convênio). O mapeamento cabeçalho da
 * planilha -> campo canônico é feito no frontend (tela de upload); aqui as linhas já chegam
 * no formato de CardAccountRow. Ver services/cardAccountImport.ts.
 */
const presencaSchema = z.object({ limite: z.boolean(), saldo: z.boolean(), utilizado: z.boolean(), status: z.boolean() });
const cardAccountSchema = z.object({
  rows: z.array(z.record(z.any())).min(1),
  camposPresentes: presencaSchema.optional(), // o que o ARQUIVO INTEIRO traz; sem isso vale o que este lote traz
  ...protecaoSchema,
});

router.post("/cartoes", importLimiter, requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const parsed = cardAccountSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: userId } = req.user!;

  if (barrarFormatoErrado(req, res, "cartoes", parsed.data.cabecalhos, parsed.data.forcarFormato)) return;

  const { importJobId, result } = await runCardAccountImport(prisma, tenantId, parsed.data.rows as CardAccountRow[], userId, {
    presence: parsed.data.camposPresentes as FieldPresence | undefined,
    loteId: parsed.data.loteId,
    nomeArquivo: parsed.data.nomeArquivo,
  });
  await logAudit({ tenantId, userId, action: "IMPORT_CARTOES_CONTAS", target: "ImportJob", targetId: importJobId, details: result });
  await refreshCiclos(tenantId);
  res.json({ importJobId, ...result });
});

/**
 * POST /api/imports/cartoes/preview — simula um lote SEM gravar nada: quantos clientes são novos/atualizados e
 * o que muda neles (limite, saldo, status, autorização). A tela soma os lotes e mostra antes de confirmar.
 */
router.post("/cartoes/preview", importLimiter, requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const parsed = cardAccountSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId } = req.user!;
  if (barrarFormatoErrado(req, res, "cartoes", parsed.data.cabecalhos, parsed.data.forcarFormato)) return;
  const preview = await previewCardAccountImport(prisma, tenantId, parsed.data.rows as CardAccountRow[], parsed.data.camposPresentes as FieldPresence | undefined);
  res.json(preview);
});

export default router;

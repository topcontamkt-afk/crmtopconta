import { Router } from "express";
import { z } from "zod";
import { prisma, tenantRaw } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../middleware/audit";
import { importLimiter } from "../middleware/rateLimit";
import { runPurchaseImport, PurchaseRow } from "../services/purchaseImport";
import { isMerchantCategory, MERCHANT_CATEGORIES } from "../services/merchantCategories";
import { buildSegmentWhere } from "../services/segments";

const router = Router();
router.use(requireAuth);

const importSchema = z.object({ rows: z.array(z.record(z.any())).min(1).max(2000) });

/**
 * POST /api/purchases/import — aba "Todas as Compras" (linhas já mapeadas no frontend). Idempotente
 * por idTransacaoCartao. Ver services/purchaseImport.ts.
 */
router.post("/import", importLimiter, requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: userId } = req.user!;

  const { importJobId, result } = await runPurchaseImport(prisma, tenantId, parsed.data.rows as PurchaseRow[], userId);
  await logAudit({
    tenantId,
    userId,
    action: "IMPORT_COMPRAS",
    target: "ImportJob",
    targetId: importJobId,
    // Sem as linhas (têm CPF/telefone): só os totais.
    details: { ...result, errors: undefined },
  });
  // addedCount/updatedCount/errorCount mantêm o mesmo formato das outras importações (a tela de
  // upload soma esses três); os campos específicos de compras vêm junto.
  res.json({ importJobId, addedCount: result.importedCount, updatedCount: result.duplicateCount, ...result });
});

const periodSchema = z.object({ days: z.coerce.number().int().min(0).max(3650).default(0) });
const sinceFor = (days: number) => (days > 0 ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : new Date(0));

/**
 * GET /api/purchases/categories?days= — clientes, compras e valor por categoria de comércio.
 * days=0 (padrão) considera todo o período importado; a resposta inclui a janela real dos dados.
 */
router.get("/categories", async (req, res) => {
  const parsed = periodSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Parâmetros inválidos" });
  const { tenantId } = req.user!;
  const since = sinceFor(parsed.data.days);

  const [rows, janela, totais] = await Promise.all([
    tenantRaw.query<Array<{ category: string; clientes: number; compras: number; valor: number; lojistas: number }>>(
      `SELECT m."category" AS category,
              COUNT(DISTINCT p."clientId")::int AS clientes,
              COUNT(*)::int AS compras,
              COALESCE(SUM(p."valorPrincipal"), 0)::float AS valor,
              COUNT(DISTINCT m."id")::int AS lojistas
       FROM "Purchase" p JOIN "Merchant" m ON m."id" = p."merchantId"
       WHERE p."tenantId" = $1 AND p."occurredAt" >= $2::timestamptz
       GROUP BY m."category"
       ORDER BY clientes DESC, compras DESC`,
      tenantId,
      since.toISOString()
    ),
    prisma.purchase.aggregate({
      where: { tenantId },
      _min: { occurredAt: true },
      _max: { occurredAt: true },
      _count: true,
    }),
    tenantRaw.query<Array<{ clientes: number; compras: number; valor: number }>>(
      `SELECT COUNT(DISTINCT p."clientId")::int AS clientes, COUNT(*)::int AS compras,
              COALESCE(SUM(p."valorPrincipal"), 0)::float AS valor
       FROM "Purchase" p
       WHERE p."tenantId" = $1 AND p."merchantId" IS NOT NULL AND p."occurredAt" >= $2::timestamptz`,
      tenantId,
      since.toISOString()
    ),
  ]);

  const label = new Map<string, string>(MERCHANT_CATEGORIES.map((c) => [c.key, c.label]));
  res.json({
    dias: parsed.data.days,
    dados: {
      totalTransacoes: janela._count,
      primeira: janela._min.occurredAt,
      ultima: janela._max.occurredAt,
    },
    totais: totais[0] ?? { clientes: 0, compras: 0, valor: 0 },
    categorias: rows.map((r) => ({ ...r, label: label.get(r.category) ?? r.category })),
    todasCategorias: MERCHANT_CATEGORIES,
  });
});

const merchantsQuerySchema = z.object({
  category: z.string().optional(),
  search: z.string().trim().max(100).optional(),
  days: z.coerce.number().int().min(0).max(3650).default(0),
});

/** GET /api/purchases/merchants — lojistas com categoria, compras, clientes e valor. */
router.get("/merchants", async (req, res) => {
  const parsed = merchantsQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Parâmetros inválidos" });
  const { tenantId } = req.user!;
  const { category, search, days } = parsed.data;
  const since = sinceFor(days);

  const rows = await tenantRaw.query<
    Array<{ id: string; name: string; category: string; categorySource: string; compras: number; clientes: number; valor: number; ultima: Date | null }>
  >(
    `SELECT m."id", m."name", m."category", m."categorySource",
            COUNT(p."id")::int AS compras,
            COUNT(DISTINCT p."clientId")::int AS clientes,
            COALESCE(SUM(p."valorPrincipal"), 0)::float AS valor,
            MAX(p."occurredAt") AS ultima
     FROM "Merchant" m
     LEFT JOIN "Purchase" p ON p."merchantId" = m."id" AND p."occurredAt" >= $2::timestamptz
     WHERE m."tenantId" = $1
       AND ($3::text IS NULL OR m."category" = $3)
       AND ($4::text IS NULL OR m."nameKey" LIKE '%' || lower($4) || '%')
     GROUP BY m."id"
     ORDER BY compras DESC, m."name" ASC
     LIMIT 500`,
    tenantId,
    since.toISOString(),
    category && isMerchantCategory(category) ? category : null,
    search || null
  );
  res.json(rows);
});

const patchMerchantSchema = z.object({ category: z.string().refine(isMerchantCategory, "Categoria inválida") });

/** PATCH /api/purchases/merchants/:id — corrige a categoria de um lojista (passa a valer como manual). */
router.patch("/merchants/:id", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const parsed = patchMerchantSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Categoria inválida" });
  const { tenantId, id: userId } = req.user!;

  const merchant = await prisma.merchant.findFirst({ where: { id: req.params.id, tenantId } });
  if (!merchant) return res.status(404).json({ error: "Lojista não encontrado" });

  const updated = await prisma.merchant.update({
    where: { id: merchant.id },
    data: { category: parsed.data.category, categorySource: "MANUAL" },
  });
  await logAudit({
    tenantId,
    userId,
    action: "MERCHANT_CATEGORY_CHANGED",
    target: "Merchant",
    targetId: merchant.id,
    details: { from: merchant.category, to: updated.category },
  });
  res.json(updated);
});

const audienceSchema = z.object({
  categorias: z.string().optional(), // lista separada por vírgula
  lojistaIds: z.string().optional(),
  days: z.coerce.number().int().min(0).max(3650).default(0),
});

/**
 * GET /api/purchases/audiencia — clientes que compraram nas categorias/lojistas pedidos (para
 * "Criar campanha" na tela de Comércio). `autorizados` conta quem pode receber comunicação.
 */
router.get("/audiencia", async (req, res) => {
  const parsed = audienceSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Parâmetros inválidos" });
  const { tenantId } = req.user!;
  const categorias = (parsed.data.categorias ?? "").split(",").filter(isMerchantCategory);
  const lojistaIds = (parsed.data.lojistaIds ?? "").split(",").filter(Boolean);
  if (categorias.length === 0 && lojistaIds.length === 0) return res.status(400).json({ error: "Informe ao menos uma categoria ou lojista" });

  const where = buildSegmentWhere(tenantId, {
    categoriasCompra: categorias.length ? categorias : undefined,
    lojistaIds: lojistaIds.length ? lojistaIds : undefined,
    compraNosUltimosDias: parsed.data.days > 0 ? parsed.data.days : undefined,
  });
  const [clients, autorizados] = await Promise.all([
    prisma.client.findMany({ where, select: { id: true }, take: 5000 }),
    prisma.client.count({ where: { AND: [where, { autorizacaoComunicacao: true, optOutAt: null }] } }),
  ]);
  res.json({ total: clients.length, autorizados, clientIds: clients.map((c) => c.id) });
});

export default router;

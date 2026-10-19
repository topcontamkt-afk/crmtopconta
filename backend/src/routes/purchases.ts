import { ENVIAVEL_WHERE } from "../services/segments";
import { parseCidades, SEM_CIDADE } from "../services/cidades";
import { emLista, sqlTs } from "../config/sql";
import { Router } from "express";
import { z } from "zod";
import { prisma, tenantRaw } from "../config/db";
import { contarEmPartes } from "../config/d1Partes";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../middleware/audit";
import { importLimiter } from "../middleware/rateLimit";
import { runPurchaseImport, PurchaseRow } from "../services/purchaseImport";
import { formatMismatch } from "../services/importFormat";
import { CATEGORY_MESSAGES, isMerchantCategory, MERCHANT_CATEGORIES, messageForCategories, MULTI_CATEGORY_MESSAGE, normalizeMerchantName } from "../services/merchantCategories";

const router = Router();
router.use(requireAuth);

const importSchema = z.object({
  rows: z.array(z.record(z.any())).min(1).max(2000),
  cabecalhos: z.array(z.string()).max(300).optional(),
  loteId: z.string().uuid().optional(),
  nomeArquivo: z.string().max(200).optional(),
  forcarFormato: z.boolean().optional(),
});

/**
 * POST /api/purchases/import — aba "Todas as Compras" (linhas já mapeadas no frontend). Idempotente
 * por idTransacaoCartao. Ver services/purchaseImport.ts.
 */
router.post("/import", importLimiter, requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: userId } = req.user!;

  // Mesma trava das importações de clientes: arquivo de outro formato não entra como compras.
  if (parsed.data.cabecalhos?.length) {
    const erro = formatMismatch("compras", parsed.data.cabecalhos);
    if (erro && !(parsed.data.forcarFormato && req.user!.role === "ADMIN")) {
      return res.status(422).json({ error: erro.mensagem, codigo: "FORMATO_INCOMPATIVEL", detectado: erro.detectado, escolhido: "compras" });
    }
  }

  const { importJobId, result } = await runPurchaseImport(prisma, tenantId, parsed.data.rows as PurchaseRow[], userId, { loteId: parsed.data.loteId, nomeArquivo: parsed.data.nomeArquivo });
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

const periodSchema = z.object({
  days: z.coerce.number().int().min(0).max(3650).default(0),
  cidades: z.string().max(2000).optional(), // chaves separadas por "|" (ver services/cidades.ts); vazio = todas
});
/**
 * Filtro de cidade do CLIENTE (ele só compra no comércio da própria cidade). `$n` é a lista de chaves em JSON
 * (o SQLite não tem array), ou NULL para todas.
 */
const CIDADE_KEY = 'cl."cidadeKey"';
const cidadeClause = (n: number) => `AND ($${n} IS NULL OR ${CIDADE_KEY} IN ${emLista(`$${n}`)})`;
const cidadesParam = (raw: string | undefined) => {
  const l = parseCidades(raw);
  return l.length ? JSON.stringify(l) : null;
};
const listaParam = (l: string[]) => (l.length ? JSON.stringify(l) : null);
const sinceFor = (days: number) => sqlTs(days > 0 ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : new Date(0));

/**
 * GET /api/purchases/categories?days= — clientes, compras e valor por categoria de comércio.
 * days=0 (padrão) considera todo o período importado; a resposta inclui a janela real dos dados.
 */
router.get("/categories", async (req, res) => {
  const parsed = periodSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Parâmetros inválidos" });
  const { tenantId } = req.user!;
  const since = sinceFor(parsed.data.days);
  const cidades = cidadesParam(parsed.data.cidades);

  const [rows, janela, totais] = await Promise.all([
    tenantRaw.query<Array<{ category: string; clientes: number; compras: number; valor: number; lojistas: number }>>(
      `SELECT m."category" AS category,
              COUNT(DISTINCT p."clientId") AS clientes,
              COUNT(*) AS compras,
              CAST(COALESCE(SUM(p."valorPrincipal"), 0) AS REAL) AS valor,
              COUNT(DISTINCT m."id") AS lojistas
       FROM "Purchase" p JOIN "Merchant" m ON m."id" = p."merchantId" JOIN "Client" cl ON cl."id" = p."clientId"
       WHERE p."tenantId" = $1 AND p."occurredAt" >= $2 ${cidadeClause(3)}
       GROUP BY m."category"
       ORDER BY clientes DESC, compras DESC`,
      tenantId,
      since,
      cidades
    ),
    prisma.purchase.aggregate({
      where: { tenantId },
      _min: { occurredAt: true },
      _max: { occurredAt: true },
      _count: true,
    }),
    tenantRaw.query<Array<{ clientes: number; compras: number; valor: number }>>(
      `SELECT COUNT(DISTINCT p."clientId") AS clientes, COUNT(*) AS compras,
              CAST(COALESCE(SUM(p."valorPrincipal"), 0) AS REAL) AS valor
       FROM "Purchase" p JOIN "Client" cl ON cl."id" = p."clientId"
       WHERE p."tenantId" = $1 AND p."merchantId" IS NOT NULL AND p."occurredAt" >= $2 ${cidadeClause(3)}`,
      tenantId,
      since,
      cidades
    ),
  ]);

  const label = new Map<string, string>(MERCHANT_CATEGORIES.map((c) => [c.key, c.label]));
  res.json({
    dias: parsed.data.days,
    cidades: cidades ? (JSON.parse(cidades) as string[]) : [],
    dados: {
      totalTransacoes: janela._count,
      primeira: janela._min.occurredAt,
      ultima: janela._max.occurredAt,
    },
    totais: totais[0] ?? { clientes: 0, compras: 0, valor: 0 },
    categorias: rows.map((r) => ({ ...r, label: label.get(r.category) ?? r.category })),
    todasCategorias: MERCHANT_CATEGORIES.map((c) => ({ ...c, mensagem: CATEGORY_MESSAGES[c.key] })),
    mensagemVariasCategorias: MULTI_CATEGORY_MESSAGE,
  });
});

const merchantsQuerySchema = z.object({
  category: z.string().optional(),
  search: z.string().trim().max(100).optional(),
  days: z.coerce.number().int().min(0).max(3650).default(0),
  cidades: z.string().max(2000).optional(),
});

/** GET /api/purchases/merchants — lojistas com categoria, compras, clientes e valor. */
router.get("/merchants", async (req, res) => {
  const parsed = merchantsQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Parâmetros inválidos" });
  const { tenantId } = req.user!;
  const { category, search, days } = parsed.data;
  const since = sinceFor(days);
  const cidades = cidadesParam(parsed.data.cidades);

  const rows = await tenantRaw.query<
    Array<{ id: string; name: string; category: string; categorySource: string; compras: number; clientes: number; valor: number; ultima: Date | null }>
  >(
    `SELECT m."id", m."name", m."category", m."categorySource",
            COUNT(p."id") AS compras,
            COUNT(DISTINCT p."clientId") AS clientes,
            CAST(COALESCE(SUM(p."valorPrincipal"), 0) AS REAL) AS valor,
            MAX(p."occurredAt") AS ultima
     FROM "Merchant" m
     LEFT JOIN "Purchase" p ON p."merchantId" = m."id" AND p."occurredAt" >= $2
       AND ($5 IS NULL OR EXISTS (SELECT 1 FROM "Client" cl WHERE cl."id" = p."clientId" AND ${CIDADE_KEY} IN ${emLista("$5")}))
     WHERE m."tenantId" = $1
       AND ($3 IS NULL OR m."category" = $3)
       AND ($4 IS NULL OR m."nameKey" LIKE '%' || $4 || '%')
     GROUP BY m."id"
     ORDER BY compras DESC, m."name" ASC
     LIMIT 500`,
    tenantId,
    since,
    category && isMerchantCategory(category) ? category : null,
    search ? normalizeMerchantName(search) : null,
    cidades
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

/**
 * GET /api/purchases/cidades?days= — cidades dos clientes que compraram no comércio credenciado, com quantos
 * clientes em cada. Nome de empresa ou vazio na coluna cidade aparece como "Sem cidade".
 */
router.get("/cidades", async (req, res) => {
  const parsed = periodSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Parâmetros inválidos" });
  const { tenantId } = req.user!;
  const rows = await tenantRaw.query<Array<{ chave: string; nome: string; clientes: number }>>(
    `SELECT ${CIDADE_KEY} AS chave,
            MIN(trim(cl."cidade")) AS nome,
            COUNT(DISTINCT p."clientId") AS clientes
     FROM "Purchase" p JOIN "Client" cl ON cl."id" = p."clientId"
     WHERE p."tenantId" = $1 AND p."merchantId" IS NOT NULL AND p."occurredAt" >= $2
     GROUP BY 1
     ORDER BY clientes DESC, chave ASC`,
    tenantId,
    sinceFor(parsed.data.days)
  );
  res.json(
    rows.map((r) => ({
      chave: r.chave,
      nome: r.chave === SEM_CIDADE ? "Sem cidade" : r.nome,
      clientes: r.clientes,
    }))
  );
});

const audienceSchema = z.object({
  categorias: z.string().optional(), // lista separada por vírgula
  lojistaIds: z.string().optional(),
  days: z.coerce.number().int().min(0).max(3650).default(0),
  minCompras: z.coerce.number().int().min(1).max(50).default(1),
  cidades: z.string().max(2000).optional(),
});

/**
 * GET /api/purchases/audiencia — clientes que compraram nas categorias/lojistas pedidos, com no
 * mínimo `minCompras` compras (para "Criar campanha" na tela de Comércio). Devolve também quantos
 * clientes há por frequência (1+, 2+, 3+) e quantos podem receber (sem opt-out), mais a mensagem
 * sugerida para essas categorias.
 */
router.get("/audiencia", async (req, res) => {
  const parsed = audienceSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Parâmetros inválidos" });
  const { tenantId } = req.user!;
  const categorias = (parsed.data.categorias ?? "").split(",").filter(isMerchantCategory);
  const lojistaIds = (parsed.data.lojistaIds ?? "").split(",").filter(Boolean);
  if (categorias.length === 0 && lojistaIds.length === 0) return res.status(400).json({ error: "Informe ao menos uma categoria ou lojista" });

  const porCliente = await tenantRaw.query<Array<{ id: string; n: number }>>(
    `SELECT p."clientId" AS id, COUNT(*) AS n
     FROM "Purchase" p JOIN "Merchant" m ON m."id" = p."merchantId" JOIN "Client" cl ON cl."id" = p."clientId"
     WHERE p."tenantId" = $1 AND p."occurredAt" >= $2
       AND ($3 IS NULL OR m."category" IN ${emLista("$3")})
       AND ($4 IS NULL OR m."id" IN ${emLista("$4")})
       ${cidadeClause(5)}
     GROUP BY p."clientId"`,
    tenantId,
    sinceFor(parsed.data.days),
    listaParam(categorias),
    listaParam(lojistaIds),
    cidadesParam(parsed.data.cidades)
  );

  const porFrequencia = [1, 2, 3].map((min) => porCliente.filter((c) => c.n >= min).length);
  const ids = porCliente.filter((c) => c.n >= parsed.data.minCompras).map((c) => c.id).slice(0, 5000);
  const autorizados = ids.length
    ? await contarEmPartes({ tenantId, id: { in: ids }, autorizacaoComunicacao: true, optOutAt: null, ...ENVIAVEL_WHERE }, (where) => prisma.client.count({ where }))
    : 0;
  res.json({ total: ids.length, autorizados, porFrequencia, clientIds: ids, mensagem: messageForCategories(categorias) });
});

export default router;

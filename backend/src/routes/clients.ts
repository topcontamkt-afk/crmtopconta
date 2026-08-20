import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../middleware/audit";
import { buildSegmentWhere } from "../services/segments";

const router = Router();
router.use(requireAuth);

/** GET /api/clients — lista com filtros (cidade, faixa, status, autorização, busca, paginação) */
router.get("/", async (req, res) => {
  const { tenantId } = req.user!;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Number(req.query.pageSize) || 25);

  const where = buildSegmentWhere(tenantId, {
    cidade: req.query.cidade ? String(req.query.cidade).split(",") : undefined,
    faixaUso: req.query.faixaUso ? String(req.query.faixaUso).split(",") : undefined,
    statusConta: req.query.statusConta ? String(req.query.statusConta).split(",") : undefined,
    autorizacaoComunicacao:
      req.query.autorizacao !== undefined ? req.query.autorizacao === "true" : undefined,
    semUsoDiasMin: req.query.semUsoDiasMin ? Number(req.query.semUsoDiasMin) : undefined,
    search: req.query.search ? String(req.query.search) : undefined,
  });

  const [items, total] = await Promise.all([
    prisma.client.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.client.count({ where }),
  ]);

  res.json({ items, total, page, pageSize });
});

/**
 * GET /api/clients/export.csv — export restrito por papel (Fase 2 — Should have).
 * Precisa vir antes de "/:id" para não ser capturada como um id de cliente.
 */
router.get("/export.csv", requireRole("ADMIN", "OPERATOR", "ANALYST"), async (req, res) => {
  const { tenantId, id: userId } = req.user!;
  const where = buildSegmentWhere(tenantId, {
    cidade: req.query.cidade ? String(req.query.cidade).split(",") : undefined,
    faixaUso: req.query.faixaUso ? String(req.query.faixaUso).split(",") : undefined,
    statusConta: req.query.statusConta ? String(req.query.statusConta).split(",") : undefined,
    search: req.query.search ? String(req.query.search) : undefined,
  });

  const clients = await prisma.client.findMany({ where, orderBy: { nome: "asc" }, take: 50000 });

  const header = "nome,telefone,cpf_mascarado,cidade,percentual_utilizado,faixa_uso,status,autorizacao_comunicacao\n";
  const rows = clients
    .map((c) =>
      [
        csvEscape(c.nome),
        c.telefone,
        c.cpfMasked,
        csvEscape(c.cidade || ""),
        Number(c.percentualUtilizado),
        c.faixaUso,
        c.statusConta,
        c.autorizacaoComunicacao ? "sim" : "nao",
      ].join(",")
    )
    .join("\n");

  await logAudit({ tenantId, userId, action: "EXPORT_CLIENTS", target: "Client", details: { count: clients.length } });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="clientes.csv"`);
  res.send(header + rows);
});

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

router.get("/:id", async (req, res) => {
  const { tenantId } = req.user!;
  const client = await prisma.client.findFirst({
    where: { id: req.params.id, tenantId },
    include: {
      movements: { orderBy: { data: "desc" }, take: 50 },
      messageEvents: { orderBy: { queuedAt: "desc" }, take: 50, include: { campaign: true } },
    },
  });
  if (!client) return res.status(404).json({ error: "Cliente não encontrado" });
  res.json(client);
});

const updateSchema = z.object({
  nome: z.string().optional(),
  cidade: z.string().optional(),
  statusConta: z.enum(["ATIVO", "INATIVO", "BLOQUEADO"]).optional(),
  autorizacaoComunicacao: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
});

router.patch("/:id", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const { tenantId, id: userId } = req.user!;
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existing = await prisma.client.findFirst({ where: { id: req.params.id, tenantId } });
  if (!existing) return res.status(404).json({ error: "Cliente não encontrado" });

  const data: any = { ...parsed.data };
  // Se a autorização estiver sendo removida, registra o opt-out (bloqueio imediato e permanente até novo consentimento explícito)
  if (parsed.data.autorizacaoComunicacao === false && existing.autorizacaoComunicacao) {
    data.optOutAt = new Date();
  }
  if (parsed.data.autorizacaoComunicacao === true) {
    data.optOutAt = null;
  }

  const updated = await prisma.client.update({ where: { id: existing.id }, data });
  await logAudit({
    tenantId,
    userId,
    action: "UPDATE_CLIENT",
    target: "Client",
    targetId: existing.id,
    details: parsed.data,
  });
  res.json(updated);
});

/** POST /api/clients/bulk — ações em massa: tag ou bloqueio */
const bulkSchema = z.object({
  clientIds: z.array(z.string()).min(1),
  action: z.enum(["ADD_TAG", "REMOVE_TAG", "BLOCK", "OPT_OUT"]),
  tag: z.string().optional(),
});

router.post("/bulk", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const { tenantId, id: userId } = req.user!;
  const parsed = bulkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { clientIds, action, tag } = parsed.data;

  const clients = await prisma.client.findMany({ where: { id: { in: clientIds }, tenantId } });

  for (const c of clients) {
    if (action === "ADD_TAG" && tag) {
      await prisma.client.update({ where: { id: c.id }, data: { tags: { push: tag } } });
    } else if (action === "REMOVE_TAG" && tag) {
      await prisma.client.update({ where: { id: c.id }, data: { tags: c.tags.filter((t) => t !== tag) } });
    } else if (action === "BLOCK") {
      await prisma.client.update({ where: { id: c.id }, data: { statusConta: "BLOQUEADO" } });
    } else if (action === "OPT_OUT") {
      await prisma.client.update({
        where: { id: c.id },
        data: { autorizacaoComunicacao: false, optOutAt: new Date() },
      });
    }
  }

  await logAudit({ tenantId, userId, action: `BULK_${action}`, target: "Client", details: { clientIds, tag } });
  res.json({ affected: clients.length });
});

export default router;

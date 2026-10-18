import { Router } from "express";
import { prisma } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { ACOES_ACESSO_INDEVIDO } from "../middleware/audit";
import { verifyAuditChain } from "../services/auditIntegrity";

const router = Router();
router.use(requireAuth);

/**
 * LGPD 05-03: filtro por ação. `grupo=acesso_indevido` traz login falho, bloqueio, 2FA falho,
 * acesso negado e importação de planilha negada; `action=A,B` filtra por ações específicas.
 * Devolve null quando não há filtro.
 */
export function actionFilter(query: { action?: unknown; grupo?: unknown }): string[] | null {
  const acoes = new Set<string>();
  if (query.grupo === "acesso_indevido") Object.values(ACOES_ACESSO_INDEVIDO).forEach((a) => acoes.add(a));
  if (typeof query.action === "string") {
    query.action
      .split(",")
      .map((a) => a.trim())
      .filter((a) => a.length > 0 && a.length <= 64)
      .slice(0, 20)
      .forEach((a) => acoes.add(a));
  }
  return acoes.size > 0 ? [...acoes] : null;
}

/** GET /api/audit-logs — visível apenas para ADMIN/ANALYST (compliance/auditoria). */
router.get("/", requireRole("ADMIN", "ANALYST"), async (req, res) => {
  const acoes = actionFilter(req.query);
  const logs = await prisma.auditLog.findMany({
    where: { tenantId: req.user!.tenantId, ...(acoes ? { action: { in: acoes } } : {}) },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { user: { select: { name: true, email: true } } },
  });
  res.json(logs);
});

/**
 * GET /api/audit-logs/verify-integrity — percorre a cadeia de hash do AuditLog (achado #11,
 * tamper-evidence) e reporta se alguma entrada foi alterada/removida desde que foi gravada.
 * LGPD 08-08: verifica só a cadeia do tenant autenticado (não lê nem expõe linhas de outros
 * controladores). Ver a transição global → por tenant em services/auditIntegrity.ts.
 */
router.get("/verify-integrity", requireRole("ADMIN", "ANALYST"), async (req, res) => {
  const result = await verifyAuditChain(req.user!.tenantId);
  res.json(result);
});

export default router;

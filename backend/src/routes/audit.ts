import { Router } from "express";
import { prisma } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { verifyAuditChain } from "../services/auditIntegrity";

const router = Router();
router.use(requireAuth);

/** GET /api/audit-logs — visível apenas para ADMIN/ANALYST (compliance/auditoria). */
router.get("/", requireRole("ADMIN", "ANALYST"), async (req, res) => {
  const logs = await prisma.auditLog.findMany({
    where: { tenantId: req.user!.tenantId },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { user: { select: { name: true, email: true } } },
  });
  res.json(logs);
});

/**
 * GET /api/audit-logs/verify-integrity — percorre a cadeia de hash do AuditLog (achado #11,
 * tamper-evidence) e reporta se alguma entrada foi alterada/removida desde que foi gravada.
 * Cross-tenant por natureza (a cadeia é global, ver services/auditIntegrity.ts), mas o acesso
 * à rota em si continua exigindo ADMIN/ANALYST do tenant autenticado.
 */
router.get("/verify-integrity", requireRole("ADMIN", "ANALYST"), async (_req, res) => {
  const result = await verifyAuditChain();
  res.json(result);
});

export default router;

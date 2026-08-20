import { Router } from "express";
import { prisma } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";

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

export default router;

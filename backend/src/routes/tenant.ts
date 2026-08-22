import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../middleware/audit";

const router = Router();
router.use(requireAuth);

/** GET /api/tenant/settings — configurações operacionais do tenant. */
router.get("/settings", async (req, res) => {
  // findUnique (não findUniqueOrThrow) — um tenantId de um JWT válido para um tenant já
  // removido não deve gerar um P2025 não tratado (500 cru), e sim um 404 genérico.
  const tenant = await prisma.tenant.findUnique({
    where: { id: req.user!.tenantId },
    select: { id: true, name: true, retentionDays: true, maxMsgsPerMinute: true },
  });
  if (!tenant) return res.status(404).json({ error: "Tenant não encontrado" });
  res.json(tenant);
});

const settingsSchema = z.object({
  retentionDays: z.number().int().positive().optional(),
  maxMsgsPerMinute: z.number().int().positive().optional(),
});

/** PUT /api/tenant/settings — política de retenção (LGPD) e rate limit global de envio. */
router.put("/settings", requireRole("ADMIN"), async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: userId } = req.user!;

  const tenant = await prisma.tenant.update({ where: { id: tenantId }, data: parsed.data });
  await logAudit({ tenantId, userId, action: "UPDATE_TENANT_SETTINGS", target: "Tenant", targetId: tenantId, details: parsed.data });
  res.json({ id: tenant.id, retentionDays: tenant.retentionDays, maxMsgsPerMinute: tenant.maxMsgsPerMinute });
});

export default router;

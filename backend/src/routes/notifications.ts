import { Router } from "express";
import { prisma } from "../config/db";
import { requireAuth } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

router.get("/", async (req, res) => {
  const unreadOnly = req.query.unreadOnly === "true";
  const notifications = await prisma.notification.findMany({
    where: { tenantId: req.user!.tenantId, read: unreadOnly ? false : undefined },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  res.json(notifications);
});

router.post("/:id/read", async (req, res) => {
  const notification = await prisma.notification.findFirst({ where: { id: req.params.id, tenantId: req.user!.tenantId } });
  if (!notification) return res.status(404).json({ error: "Notificação não encontrada" });
  const updated = await prisma.notification.update({ where: { id: notification.id }, data: { read: true } });
  res.json(updated);
});

router.post("/read-all", async (req, res) => {
  await prisma.notification.updateMany({ where: { tenantId: req.user!.tenantId, read: false }, data: { read: true } });
  res.json({ ok: true });
});

export default router;

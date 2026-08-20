import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../middleware/audit";

const router = Router();
router.use(requireAuth);

router.get("/", requireRole("ADMIN"), async (req, res) => {
  const users = await prisma.user.findMany({
    where: { tenantId: req.user!.tenantId },
    select: { id: true, name: true, email: true, role: true, active: true, createdAt: true },
  });
  res.json(users);
});

const createSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(["ADMIN", "OPERATOR", "ANALYST", "VIEWER"]),
});

router.post("/", requireRole("ADMIN"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: adminId } = req.user!;
  const { name, email, password, role } = parsed.data;

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({ data: { tenantId, name, email, passwordHash, role } });
  await logAudit({ tenantId, userId: adminId, action: "CREATE_USER", target: "User", targetId: user.id, details: { email, role } });

  res.status(201).json({ id: user.id, name: user.name, email: user.email, role: user.role });
});

router.patch("/:id", requireRole("ADMIN"), async (req, res) => {
  const { tenantId, id: adminId } = req.user!;
  const target = await prisma.user.findFirst({ where: { id: req.params.id, tenantId } });
  if (!target) return res.status(404).json({ error: "Usuário não encontrado" });

  const updated = await prisma.user.update({
    where: { id: target.id },
    data: { role: req.body.role ?? target.role, active: req.body.active ?? target.active },
  });
  await logAudit({ tenantId, userId: adminId, action: "UPDATE_USER", target: "User", targetId: target.id, details: req.body });
  res.json({ id: updated.id, role: updated.role, active: updated.active });
});

export default router;

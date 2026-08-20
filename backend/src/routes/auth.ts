import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../config/db";
import { signToken } from "../middleware/auth";
import { logAudit } from "../middleware/audit";

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos" });

  const { email, password } = parsed.data;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.active) return res.status(401).json({ error: "Credenciais inválidas" });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Credenciais inválidas" });

  const token = signToken({ id: user.id, tenantId: user.tenantId, role: user.role, email: user.email });
  await logAudit({ tenantId: user.tenantId, userId: user.id, action: "LOGIN", target: "User", targetId: user.id });

  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, tenantId: user.tenantId },
  });
});

export default router;

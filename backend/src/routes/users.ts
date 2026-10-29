import { Router } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../middleware/audit";
import { invalidateAccessCache } from "../middleware/areaAccess";
import { allowedAreas, cleanAreas } from "../services/areas";

const router = Router();
router.use(requireAuth);

router.get("/", requireRole("ADMIN"), async (req, res) => {
  const users = await prisma.user.findMany({
    where: { tenantId: req.user!.tenantId },
    select: { id: true, name: true, email: true, role: true, active: true, createdAt: true, areasRestritas: true, areas: true },
    orderBy: { createdAt: "asc" },
  });
  // `areas`: lista liberada, ou null = todas (Admin ou sem restrição)
  res.json(users.map(({ areasRestritas, areas, ...u }) => ({ ...u, areas: allowedAreas({ role: u.role, areasRestritas, areas }) })));
});

const createSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(["ADMIN", "OPERATOR", "ANALYST", "VIEWER"]),
  areas: z.array(z.string()).nullable().optional(), // null/ausente = todas as áreas
});

router.post("/", requireRole("ADMIN"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: adminId } = req.user!;
  const { name, email, password, role } = parsed.data;
  const restritas = Array.isArray(parsed.data.areas);
  const areas = restritas ? cleanAreas(parsed.data.areas) : [];

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({ data: { tenantId, name, email, passwordHash, role, areasRestritas: restritas, areas } });
  await logAudit({ tenantId, userId: adminId, action: "CREATE_USER", target: "User", targetId: user.id, details: { email, role, areas: restritas ? areas : "todas" } });

  res.status(201).json({ id: user.id, name: user.name, email: user.email, role: user.role });
});

router.patch("/:id", requireRole("ADMIN"), async (req, res) => {
  const { tenantId, id: adminId } = req.user!;
  const target = await prisma.user.findFirst({ where: { id: req.params.id, tenantId } });
  if (!target) return res.status(404).json({ error: "Usuário não encontrado" });

  // `areas`: lista = restringe a essas áreas; null = libera todas; ausente = não mexe
  const areasInformadas = req.body.areas !== undefined;
  if (areasInformadas && req.body.areas !== null && !Array.isArray(req.body.areas)) return res.status(400).json({ error: "areas inválidas" });
  const updated = await prisma.user.update({
    where: { id: target.id },
    data: {
      role: req.body.role ?? target.role,
      active: req.body.active ?? target.active,
      ...(areasInformadas ? { areasRestritas: req.body.areas !== null, areas: req.body.areas === null ? [] : cleanAreas(req.body.areas) } : {}),
    },
  });
  invalidateAccessCache(target.id);
  // Não loga req.body bruto: só os dois campos realmente aplicados acima, ambos não-PII
  // (enum de papel e flag booleana) — evita persistir indefinidamente no AuditLog qualquer
  // campo extra que o cliente HTTP venha a incluir no payload no futuro.
  await logAudit({
    tenantId,
    userId: adminId,
    action: "UPDATE_USER",
    target: "User",
    targetId: target.id,
    details: { role: updated.role, active: updated.active, ...(areasInformadas ? { areas: updated.areasRestritas ? updated.areas : "todas" } : {}) },
  });
  res.json({ id: updated.id, role: updated.role, active: updated.active, areas: allowedAreas(updated) });
});

/**
 * POST /api/users/:id/reset-password — reset por Admin, sem depender de envio de e-mail (não
 * configurado no MVP). Gera uma senha temporária forte, força troca no próximo login e limpa
 * qualquer bloqueio de rate limiting ativo na conta. A senha em texto plano só existe nesta
 * resposta — o Admin repassa ao usuário por um canal fora do sistema (ex.: WhatsApp, presencial).
 */
router.post("/:id/reset-password", requireRole("ADMIN"), async (req, res) => {
  const { tenantId, id: adminId } = req.user!;
  const target = await prisma.user.findFirst({ where: { id: req.params.id, tenantId } });
  if (!target) return res.status(404).json({ error: "Usuário não encontrado" });

  const tempPassword = crypto.randomBytes(9).toString("base64url");
  const passwordHash = await bcrypt.hash(tempPassword, 10);

  await prisma.user.update({
    where: { id: target.id },
    data: { passwordHash, mustChangePassword: true, failedLoginCount: 0, lockedUntil: null },
  });
  await logAudit({ tenantId, userId: adminId, action: "RESET_PASSWORD_ADMIN", target: "User", targetId: target.id });

  res.json({ tempPassword });
});

export default router;

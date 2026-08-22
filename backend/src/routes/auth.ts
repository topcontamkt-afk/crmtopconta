import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../config/db";
import { requireAuth, signPending2FAToken, signToken, verifyPending2FAToken } from "../middleware/auth";
import { logAudit } from "../middleware/audit";
import { twoFactorVerifyLimiter } from "../middleware/rateLimit";
import {
  isLocked,
  lockedMinutesRemaining,
  registerFailedLogin,
  resetFailedLogins,
} from "../services/authSecurity";
import {
  buildOtpAuthUri,
  buildQrCodeDataUri,
  decryptTwoFactorSecret,
  encryptTwoFactorSecret,
  generateSecret,
  verifyToken as verifyTotpToken,
} from "../services/twoFactor";

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

  if (isLocked(user)) {
    return res.status(423).json({
      error: `Conta temporariamente bloqueada por excesso de tentativas. Tente novamente em ${lockedMinutesRemaining(user)} min.`,
    });
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    await registerFailedLogin(prisma, user.id, user.failedLoginCount);
    return res.status(401).json({ error: "Credenciais inválidas" });
  }

  await resetFailedLogins(prisma, user.id);

  if (user.twoFactorEnabled) {
    const tempToken = signPending2FAToken(user.id);
    return res.json({ requires2FA: true, tempToken });
  }

  const token = signToken({ id: user.id, tenantId: user.tenantId, role: user.role, email: user.email });
  await logAudit({ tenantId: user.tenantId, userId: user.id, action: "LOGIN", target: "User", targetId: user.id });

  res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
      mustChangePassword: user.mustChangePassword,
    },
  });
});

const verify2faSchema = z.object({
  tempToken: z.string(),
  code: z.string().min(6).max(6),
});

/** POST /api/auth/2fa/verify — segunda etapa do login quando o usuário tem 2FA ativo. */
router.post("/2fa/verify", twoFactorVerifyLimiter, async (req, res) => {
  const parsed = verify2faSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos" });

  let userId: string;
  try {
    userId = verifyPending2FAToken(parsed.data.tempToken);
  } catch {
    return res.status(401).json({ error: "Sessão de verificação expirada, faça login novamente" });
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.active || !user.twoFactorEnabled || !user.twoFactorSecret) {
    return res.status(401).json({ error: "Não foi possível verificar o código" });
  }

  const secret = decryptTwoFactorSecret(user.twoFactorSecret);
  if (!verifyTotpToken(parsed.data.code, secret)) {
    return res.status(401).json({ error: "Código inválido" });
  }

  const token = signToken({ id: user.id, tenantId: user.tenantId, role: user.role, email: user.email });
  await logAudit({ tenantId: user.tenantId, userId: user.id, action: "LOGIN_2FA", target: "User", targetId: user.id });

  res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
      mustChangePassword: user.mustChangePassword,
    },
  });
});

router.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
  res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    tenantId: user.tenantId,
    mustChangePassword: user.mustChangePassword,
    twoFactorEnabled: user.twoFactorEnabled,
  });
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, "A nova senha precisa ter pelo menos 8 caracteres"),
});

/** POST /api/auth/change-password — troca de senha self-service (usuário logado). */
router.post("/change-password", requireAuth, async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Dados inválidos" });

  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
  const ok = await bcrypt.compare(parsed.data.currentPassword, user.passwordHash);
  if (!ok) return res.status(400).json({ error: "Senha atual incorreta" });

  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 10);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash, mustChangePassword: false } });
  await logAudit({ tenantId: user.tenantId, userId: user.id, action: "CHANGE_PASSWORD", target: "User", targetId: user.id });

  res.json({ ok: true });
});

/** POST /api/auth/2fa/setup — gera um novo segredo TOTP (ainda não ativado) e o QR code para escanear. */
router.post("/2fa/setup", requireAuth, async (req, res) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });

  const secret = generateSecret();
  await prisma.user.update({
    where: { id: user.id },
    data: { twoFactorSecret: encryptTwoFactorSecret(secret), twoFactorEnabled: false },
  });

  const otpAuthUri = buildOtpAuthUri(user.email, secret);
  const qrCodeDataUri = await buildQrCodeDataUri(otpAuthUri);

  res.json({ qrCodeDataUri, secret });
});

const enable2faSchema = z.object({ code: z.string().min(6).max(6) });

/** POST /api/auth/2fa/enable — confirma o setup com um código válido do app autenticador. */
router.post("/2fa/enable", requireAuth, async (req, res) => {
  const parsed = enable2faSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Código inválido" });

  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
  if (!user.twoFactorSecret) return res.status(400).json({ error: "Configure o 2FA (setup) antes de ativar" });

  const secret = decryptTwoFactorSecret(user.twoFactorSecret);
  if (!verifyTotpToken(parsed.data.code, secret)) {
    return res.status(400).json({ error: "Código inválido" });
  }

  await prisma.user.update({ where: { id: user.id }, data: { twoFactorEnabled: true } });
  await logAudit({ tenantId: user.tenantId, userId: user.id, action: "ENABLE_2FA", target: "User", targetId: user.id });
  res.json({ ok: true });
});

const disable2faSchema = z.object({ password: z.string().min(1) });

/** POST /api/auth/2fa/disable — exige a senha atual para desativar (evita desativação por sessão sequestrada). */
router.post("/2fa/disable", requireAuth, async (req, res) => {
  const parsed = disable2faSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos" });

  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
  const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!ok) return res.status(400).json({ error: "Senha incorreta" });

  await prisma.user.update({ where: { id: user.id }, data: { twoFactorEnabled: false, twoFactorSecret: null } });
  await logAudit({ tenantId: user.tenantId, userId: user.id, action: "DISABLE_2FA", target: "User", targetId: user.id });
  res.json({ ok: true });
});

export default router;

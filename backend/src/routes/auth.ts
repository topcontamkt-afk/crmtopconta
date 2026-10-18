import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../config/db";
import { requireAuth, signPending2FAToken, signToken, verifyPending2FAToken } from "../middleware/auth";
import { ACOES_ACESSO_INDEVIDO, logAudit, logTentativaAcesso, origemRequisicao } from "../middleware/audit";
import { allowedAreas } from "../services/areas";
import { twoFactorVerifyLimiter } from "../middleware/rateLimit";
import { runWithTenantContextAsync, withCrossTenantAccess } from "../config/tenantGuard";
import {
  isLocked,
  lockedMinutesRemaining,
  maskEmail,
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
  // Lookup por email é genuinamente cross-tenant: ainda não sabemos a qual tenant este usuário
  // pertence (é exatamente isso que estamos descobrindo) — RLS real (config/tenantGuard.ts) não
  // tem uma GUC de tenant pra setar aqui, então precisa do mesmo desvio dos jobs de scheduler.
  const user = await withCrossTenantAccess(() => prisma.user.findUnique({ where: { email } }));
  const emailMascarado = maskEmail(email);
  // LGPD 05-03: nunca senha nem token nos detalhes; e-mail só mascarado; IP e User-Agent da origem.
  const origem = origemRequisicao(req);

  // LGPD 05-03: e-mail inexistente não tem tenant. Gravar no AuditLog de algum controlador seria
  // atribuir a ele uma tentativa que pode não ser dele (e expor o e-mail tentado a quem não deve
  // vê-lo). Decisão: NÃO grava no AuditLog; fica só uma linha estruturada no log do servidor, com
  // e-mail mascarado, e a tentativa continua limitada por IP no rate limit. Reter esse log por mais
  // tempo (log drain) é pendência de infraestrutura (ver docs/lgpd/correcoes).
  if (!user) {
    console.warn(JSON.stringify({ evento: ACOES_ACESSO_INDEVIDO.LOGIN_FALHA, motivo: "EMAIL_DESCONHECIDO", email: emailMascarado, ip: origem.ip, em: new Date().toISOString() }));
    return res.status(401).json({ error: "Credenciais inválidas" });
  }
  if (!user.active) {
    // E-mail existe: a tentativa vai para o AuditLog do tenant dele, já no contexto de RLS dele.
    await runWithTenantContextAsync(user.tenantId, () =>
      logTentativaAcesso({ tenantId: user.tenantId, userId: user.id, action: ACOES_ACESSO_INDEVIDO.LOGIN_FALHA, details: { email: emailMascarado, motivo: "USUARIO_INATIVO", ...origem } })
    );
    return res.status(401).json({ error: "Credenciais inválidas" });
  }

  if (isLocked(user)) {
    // LGPD 05-03: tentativa durante o bloqueio também é rastro de ataque em andamento.
    await runWithTenantContextAsync(user.tenantId, () =>
      logTentativaAcesso({ tenantId: user.tenantId, userId: user.id, action: ACOES_ACESSO_INDEVIDO.LOGIN_FALHA, details: { email: emailMascarado, motivo: "CONTA_BLOQUEADA", bloqueadaAte: user.lockedUntil?.toISOString() ?? null, ...origem } })
    );
    return res.status(423).json({
      error: `Conta temporariamente bloqueada por excesso de tentativas. Tente novamente em ${lockedMinutesRemaining(user)} min.`,
    });
  }

  // A partir daqui já sabemos o tenant do usuário — roda o resto (updates de lockout, audit log)
  // dentro do contexto de RLS real de propósito, não mais via bypass administrativo.
  await runWithTenantContextAsync(user.tenantId, async () => {
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      const falha = await registerFailedLogin(prisma, user.id, user.failedLoginCount);
      // LGPD 05-03: o contador em User é zerado no próximo login certo; o AuditLog preserva o rastro.
      await logTentativaAcesso({
        tenantId: user.tenantId,
        userId: user.id,
        action: ACOES_ACESSO_INDEVIDO.LOGIN_FALHA,
        details: { email: emailMascarado, motivo: "SENHA_INVALIDA", tentativa: falha.count, ...origem },
      });
      if (falha.locked) {
        await logTentativaAcesso({
          tenantId: user.tenantId,
          userId: user.id,
          action: ACOES_ACESSO_INDEVIDO.LOGIN_BLOQUEADO,
          details: { email: emailMascarado, tentativas: falha.count, bloqueadaAte: falha.lockedUntil?.toISOString() ?? null, ...origem },
        });
      }
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
        areas: allowedAreas(user),
      },
    });
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

  // Mesmo motivo do /login: ainda não sabemos o tenant deste userId até buscá-lo.
  const user = await withCrossTenantAccess(() => prisma.user.findUnique({ where: { id: userId } }));
  // LGPD 05-03: token pending2FA inválido/expirado não identifica o usuário com segurança (fica só
  // no rate limit por IP). Com o usuário identificado, a falha vai para o AuditLog do tenant dele.
  if (!user) return res.status(401).json({ error: "Não foi possível verificar o código" });
  const falha2FA = (motivo: string) =>
    runWithTenantContextAsync(user.tenantId, () =>
      logTentativaAcesso({ tenantId: user.tenantId, userId: user.id, action: ACOES_ACESSO_INDEVIDO.FALHA_2FA, details: { email: maskEmail(user.email), motivo, ...origemRequisicao(req) } })
    );
  if (!user.active || !user.twoFactorEnabled || !user.twoFactorSecret) {
    await falha2FA(!user.active ? "USUARIO_INATIVO" : "2FA_NAO_ATIVO");
    return res.status(401).json({ error: "Não foi possível verificar o código" });
  }

  const secret = decryptTwoFactorSecret(user.twoFactorSecret);
  if (!verifyTotpToken(parsed.data.code, secret)) {
    await falha2FA("CODIGO_INVALIDO");
    return res.status(401).json({ error: "Código inválido" });
  }

  await runWithTenantContextAsync(user.tenantId, async () => {
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
        areas: allowedAreas(user),
      },
    });
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
    areas: allowedAreas(user),
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
  if (!ok) {
    // LGPD 05-03: senha errada numa sessão já aberta pode ser sessão sequestrada.
    await logTentativaAcesso({ tenantId: user.tenantId, userId: user.id, action: ACOES_ACESSO_INDEVIDO.LOGIN_FALHA, details: { email: maskEmail(user.email), motivo: "SENHA_ATUAL_INVALIDA_TROCA_SENHA", ...origemRequisicao(req) } });
    return res.status(400).json({ error: "Senha atual incorreta" });
  }

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
  if (!ok) {
    // LGPD 05-03: tentativa de desligar o 2FA com senha errada (possível sessão sequestrada).
    await logTentativaAcesso({ tenantId: user.tenantId, userId: user.id, action: ACOES_ACESSO_INDEVIDO.LOGIN_FALHA, details: { email: maskEmail(user.email), motivo: "SENHA_INVALIDA_DESATIVAR_2FA", ...origemRequisicao(req) } });
    return res.status(400).json({ error: "Senha incorreta" });
  }

  await prisma.user.update({ where: { id: user.id }, data: { twoFactorEnabled: false, twoFactorSecret: null } });
  await logAudit({ tenantId: user.tenantId, userId: user.id, action: "DISABLE_2FA", target: "User", targetId: user.id });
  res.json({ ok: true });
});

export default router;

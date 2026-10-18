/**
 * LGPD 05-03: tentativas de acesso indevido ficam no AuditLog do tenant, com ação própria e sem
 * senha, token ou e-mail inteiro nos detalhes. Prisma e gravação da auditoria mockados.
 */
import express from "express";
import request from "supertest";
import bcrypt from "bcryptjs";

const findUnique = jest.fn();
const userUpdate = jest.fn(async (_a?: any) => ({}));
jest.mock("../config/db", () => ({
  prisma: { user: { findUnique: (a: any) => findUnique(a), update: (a: any) => userUpdate(a), findUniqueOrThrow: (a: any) => findUnique(a) } },
}));
jest.mock("../config/tenantGuard", () => ({
  withCrossTenantAccess: (fn: () => any) => fn(),
  runWithTenantContextAsync: (_t: string, fn: () => any) => fn(),
}));
const logTentativaAcesso = jest.fn(async (_p?: any) => undefined);
const logAudit = jest.fn(async (_p?: any) => undefined);
jest.mock("../middleware/audit", () => ({
  ...jest.requireActual("../middleware/audit"),
  logTentativaAcesso: (p: any) => logTentativaAcesso(p),
  logAudit: (p: any) => logAudit(p),
}));
jest.mock("../middleware/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: "u1", tenantId: "t1", role: "ADMIN" };
    next();
  },
  signToken: () => "jwt",
  signPending2FAToken: () => "pending",
  verifyPending2FAToken: (t: string) => {
    if (t !== "pending-ok") throw new Error("expirado");
    return "u1";
  },
}));
jest.mock("../middleware/rateLimit", () => ({ twoFactorVerifyLimiter: (_q: any, _r: any, n: any) => n() }));
jest.mock("../services/twoFactor", () => ({
  decryptTwoFactorSecret: (s: string) => s,
  verifyToken: (code: string) => code === "123456",
  buildOtpAuthUri: jest.fn(),
  buildQrCodeDataUri: jest.fn(),
  encryptTwoFactorSecret: jest.fn(),
  generateSecret: jest.fn(),
}));

import router from "./auth";
import { MAX_FAILED_ATTEMPTS } from "../services/authSecurity";

const app = express();
app.use(express.json());
app.use("/auth", router);

const SENHA = "senha-certa";
const HASH = bcrypt.hashSync(SENHA, 4);
const usuario = (extra: Record<string, unknown> = {}) => ({
  id: "u1",
  tenantId: "t1",
  email: "joao.silva@empresa.com",
  name: "João",
  role: "OPERATOR",
  active: true,
  passwordHash: HASH,
  failedLoginCount: 0,
  lockedUntil: null,
  twoFactorEnabled: false,
  twoFactorSecret: null,
  mustChangePassword: false,
  areasRestritas: false,
  areas: [],
  ...extra,
});

/** Nada de senha, token, código ou e-mail inteiro em nenhum detalhe gravado. */
function semSegredos() {
  const tudo = JSON.stringify(logTentativaAcesso.mock.calls);
  expect(tudo).not.toContain(SENHA);
  expect(tudo).not.toContain("senha-errada");
  expect(tudo).not.toContain("joao.silva@");
  expect(tudo).not.toContain("pending-ok");
  expect(tudo).not.toContain("654321");
}

describe("POST /auth/login — tentativas no AuditLog (LGPD 05-03)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("senha errada grava LOGIN_FALHA no tenant do usuário, com e-mail mascarado e origem", async () => {
    findUnique.mockResolvedValue(usuario());
    const r = await request(app).post("/auth/login").set("x-real-ip", "203.0.113.7").set("user-agent", "curl/8").send({ email: "joao.silva@empresa.com", password: "senha-errada" });
    expect(r.status).toBe(401);
    expect(logTentativaAcesso).toHaveBeenCalledTimes(1);
    expect(logTentativaAcesso.mock.calls[0][0]).toMatchObject({
      tenantId: "t1",
      userId: "u1",
      action: "LOGIN_FALHA",
      details: { email: "jo***@empresa.com", motivo: "SENHA_INVALIDA", tentativa: 1, ip: "203.0.113.7", userAgent: "curl/8" },
    });
    semSegredos();
  });

  it("a tentativa que atinge o limite grava também LOGIN_BLOQUEADO", async () => {
    findUnique.mockResolvedValue(usuario({ failedLoginCount: MAX_FAILED_ATTEMPTS - 1 }));
    const r = await request(app).post("/auth/login").send({ email: "joao.silva@empresa.com", password: "senha-errada" });
    expect(r.status).toBe(401);
    expect(logTentativaAcesso.mock.calls.map((c) => c[0].action)).toEqual(["LOGIN_FALHA", "LOGIN_BLOQUEADO"]);
    expect(logTentativaAcesso.mock.calls[1][0].details).toMatchObject({ tentativas: MAX_FAILED_ATTEMPTS, bloqueadaAte: expect.any(String) });
    semSegredos();
  });

  it("tentativa com a conta já bloqueada também fica registrada (423)", async () => {
    findUnique.mockResolvedValue(usuario({ lockedUntil: new Date(Date.now() + 600_000) }));
    const r = await request(app).post("/auth/login").send({ email: "joao.silva@empresa.com", password: SENHA });
    expect(r.status).toBe(423);
    expect(logTentativaAcesso.mock.calls[0][0]).toMatchObject({ action: "LOGIN_FALHA", details: { motivo: "CONTA_BLOQUEADA" } });
  });

  it("usuário desativado: LOGIN_FALHA com motivo USUARIO_INATIVO", async () => {
    findUnique.mockResolvedValue(usuario({ active: false }));
    const r = await request(app).post("/auth/login").send({ email: "joao.silva@empresa.com", password: SENHA });
    expect(r.status).toBe(401);
    expect(logTentativaAcesso.mock.calls[0][0]).toMatchObject({ action: "LOGIN_FALHA", details: { motivo: "USUARIO_INATIVO" } });
  });

  it("e-mail inexistente não tem tenant: NÃO grava no AuditLog, só log do servidor mascarado", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    findUnique.mockResolvedValue(null);
    const r = await request(app).post("/auth/login").send({ email: "fulano@outro.com", password: "x" });
    expect(r.status).toBe(401);
    expect(logTentativaAcesso).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
    const linha = String(warn.mock.calls[0][0]);
    expect(linha).toContain("fu***@outro.com");
    expect(linha).not.toContain("fulano@");
    warn.mockRestore();
  });

  it("login certo não grava tentativa (só o LOGIN de sempre)", async () => {
    findUnique.mockResolvedValue(usuario());
    const r = await request(app).post("/auth/login").send({ email: "joao.silva@empresa.com", password: SENHA });
    expect(r.status).toBe(200);
    expect(logTentativaAcesso).not.toHaveBeenCalled();
    expect(logAudit.mock.calls[0][0].action).toBe("LOGIN");
  });
});

describe("POST /auth/2fa/verify — 2FA falho (LGPD 05-03)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("código errado grava 2FA_FALHA sem o código", async () => {
    findUnique.mockResolvedValue(usuario({ twoFactorEnabled: true, twoFactorSecret: "seg" }));
    const r = await request(app).post("/auth/2fa/verify").send({ tempToken: "pending-ok", code: "654321" });
    expect(r.status).toBe(401);
    expect(logTentativaAcesso.mock.calls[0][0]).toMatchObject({ tenantId: "t1", userId: "u1", action: "2FA_FALHA", details: { motivo: "CODIGO_INVALIDO", email: "jo***@empresa.com" } });
    semSegredos();
  });

  it("código certo não grava tentativa", async () => {
    findUnique.mockResolvedValue(usuario({ twoFactorEnabled: true, twoFactorSecret: "seg" }));
    const r = await request(app).post("/auth/2fa/verify").send({ tempToken: "pending-ok", code: "123456" });
    expect(r.status).toBe(200);
    expect(logTentativaAcesso).not.toHaveBeenCalled();
  });

  it("token pending inválido não identifica ninguém: só 401, sem gravar", async () => {
    const r = await request(app).post("/auth/2fa/verify").send({ tempToken: "forjado", code: "123456" });
    expect(r.status).toBe(401);
    expect(logTentativaAcesso).not.toHaveBeenCalled();
  });
});

describe("senha errada dentro da sessão (LGPD 05-03)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("trocar senha com a senha atual errada grava LOGIN_FALHA", async () => {
    findUnique.mockResolvedValue(usuario());
    const r = await request(app).post("/auth/change-password").send({ currentPassword: "senha-errada", newPassword: "nova-senha-123" });
    expect(r.status).toBe(400);
    expect(logTentativaAcesso.mock.calls[0][0]).toMatchObject({ action: "LOGIN_FALHA", details: { motivo: "SENHA_ATUAL_INVALIDA_TROCA_SENHA" } });
    semSegredos();
  });

  it("desativar 2FA com senha errada grava LOGIN_FALHA", async () => {
    findUnique.mockResolvedValue(usuario());
    const r = await request(app).post("/auth/2fa/disable").send({ password: "senha-errada" });
    expect(r.status).toBe(400);
    expect(logTentativaAcesso.mock.calls[0][0]).toMatchObject({ action: "LOGIN_FALHA", details: { motivo: "SENHA_INVALIDA_DESATIVAR_2FA" } });
  });
});

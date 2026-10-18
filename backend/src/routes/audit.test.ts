/** LGPD 05-03 (filtro das tentativas de acesso) e 08-08 (verificação só do tenant do usuário). */
import express from "express";
import request from "supertest";

const findMany = jest.fn(async (_a?: any) => [] as any[]);
const verifyAuditChain = jest.fn(async (_t?: string) => ({ valid: true, checked: 0, ancora: true, lacunasLegado: 0 }));
jest.mock("../config/db", () => ({ prisma: { auditLog: { findMany: (a: any) => findMany(a) } } }));
jest.mock("../services/auditIntegrity", () => ({ verifyAuditChain: (t: string) => verifyAuditChain(t) }));
jest.mock("../middleware/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: "u1", tenantId: "t1", role: (req.headers["x-role"] as string) || "ADMIN" };
    next();
  },
  requireRole: (...roles: string[]) => (req: any, res: any, next: any) => (roles.includes(req.user.role) ? next() : res.status(403).json({ error: "Sem permissão" })),
}));

import router, { actionFilter } from "./audit";
import { ACOES_ACESSO_INDEVIDO } from "../middleware/audit";

const app = express();
app.use("/audit-logs", router);

describe("actionFilter (LGPD 05-03)", () => {
  it("sem filtro devolve null", () => {
    expect(actionFilter({})).toBeNull();
  });

  it("grupo=acesso_indevido traz todas as ações de tentativa", () => {
    expect(actionFilter({ grupo: "acesso_indevido" })!.sort()).toEqual(Object.values(ACOES_ACESSO_INDEVIDO).sort());
    expect(actionFilter({ grupo: "acesso_indevido" })).toEqual(expect.arrayContaining(["LOGIN_FALHA", "LOGIN_BLOQUEADO", "2FA_FALHA"]));
  });

  it("action=A,B filtra por ações específicas e ignora lixo", () => {
    expect(actionFilter({ action: "LOGIN_FALHA, ,2FA_FALHA" })).toEqual(["LOGIN_FALHA", "2FA_FALHA"]);
    expect(actionFilter({ action: ["x"] })).toBeNull();
  });
});

describe("GET /audit-logs", () => {
  beforeEach(() => jest.clearAllMocks());

  it("filtra pelo tenant e pelas ações do grupo", async () => {
    const r = await request(app).get("/audit-logs?grupo=acesso_indevido");
    expect(r.status).toBe(200);
    const where = findMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe("t1");
    expect(where.action.in).toEqual(expect.arrayContaining(["LOGIN_FALHA", "LOGIN_BLOQUEADO", "2FA_FALHA"]));
  });

  it("sem filtro não restringe a ação", async () => {
    await request(app).get("/audit-logs");
    expect(findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
  });
});

describe("GET /audit-logs/verify-integrity (LGPD 08-08)", () => {
  it("verifica só a cadeia do tenant do usuário", async () => {
    const r = await request(app).get("/audit-logs/verify-integrity");
    expect(r.status).toBe(200);
    expect(verifyAuditChain).toHaveBeenCalledWith("t1");
  });

  it("continua exigindo ADMIN/ANALYST", async () => {
    const r = await request(app).get("/audit-logs/verify-integrity").set("x-role", "OPERATOR");
    expect(r.status).toBe(403);
  });
});

/**
 * Testes unitários com Prisma mockado (mesmo padrão do resto do repo). Foco: logAudit()
 * encadeia corretamente cada nova entrada no hash-chain (achado #11), agora por tenant
 * (LGPD 08-08), sem exercitar verifyAuditChain() em si (coberto em services/auditIntegrity.test.ts).
 */

jest.mock("../config/db", () => ({
  prisma: {
    auditLog: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  },
}));

import { prisma } from "../config/db";
import { ANCORA_CADEIA_TENANT, resetAnchorCache } from "../services/auditIntegrity";
import { logAcessoNegado, logAudit, logTentativaAcesso } from "./audit";

const mockPrisma = prisma as unknown as {
  auditLog: { create: jest.Mock; findFirst: jest.Mock; findMany: jest.Mock };
};

/** Simula um tenant que já tem âncora: a busca da âncora acha, e o último elo é `hash`. */
function tenantComAncora(hash: string | null, createdAt = new Date("2026-01-01T00:00:00Z")) {
  mockPrisma.auditLog.findFirst.mockImplementation(async ({ where }: any) =>
    where.action === ANCORA_CADEIA_TENANT ? { id: "ancora" } : hash ? { hash, createdAt } : null
  );
}

describe("logAudit — hash-chain por tenant", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetAnchorCache();
    mockPrisma.auditLog.create.mockImplementation(async ({ data }: any) => data);
    mockPrisma.auditLog.findMany.mockResolvedValue([]);
  });

  it("primeira entrada de um tenant novo: grava a âncora (prevHash null) e encadeia a entrada nela", async () => {
    mockPrisma.auditLog.findFirst.mockResolvedValue(null);

    await logAudit({ tenantId: "t1", userId: "u1", action: "TEST", target: "X", targetId: "x1", details: { a: 1 } });

    const [ancora, entrada] = mockPrisma.auditLog.create.mock.calls.map((c) => c[0].data);
    expect(ancora).toMatchObject({ action: ANCORA_CADEIA_TENANT, prevHash: null, details: { legadoTotal: 0, legadoUltimoHash: null } });
    expect(entrada.action).toBe("TEST");
    expect(entrada.prevHash).toBe(ancora.hash);
    expect(typeof entrada.hash).toBe("string");
    expect(entrada.createdAt.getTime()).toBeGreaterThan(ancora.createdAt.getTime());
  });

  it("encadeia com o hash da última entrada DO MESMO tenant", async () => {
    tenantComAncora("hash-anterior-t1");

    await logAudit({ tenantId: "t1", action: "TEST2" });

    expect(mockPrisma.auditLog.create).toHaveBeenCalledTimes(1);
    const { data } = mockPrisma.auditLog.create.mock.calls[0][0];
    expect(data.prevHash).toBe("hash-anterior-t1");
    // LGPD 08-08: o último elo é procurado só entre as linhas do tenant
    const buscas = mockPrisma.auditLog.findFirst.mock.calls.map((c) => c[0].where);
    expect(buscas.every((w: any) => w.tenantId === "t1")).toBe(true);
  });

  it("duas ações diferentes produzem hashes diferentes", async () => {
    tenantComAncora(null);

    await logAudit({ tenantId: "t1", action: "A" });
    await logAudit({ tenantId: "t1", action: "B" });

    const hash1 = mockPrisma.auditLog.create.mock.calls[0][0].data.hash;
    const hash2 = mockPrisma.auditLog.create.mock.calls[1][0].data.hash;
    expect(hash1).not.toBe(hash2);
  });

  it("não loga PII crua além do que já era passado — só encadeia o que o chamador enviou", async () => {
    tenantComAncora(null);

    await logAudit({ tenantId: "t1", action: "UPDATE_CLIENT", details: { fieldsChanged: ["nome"] } });

    const { data } = mockPrisma.auditLog.create.mock.calls[0][0];
    expect(data.details).toEqual({ fieldsChanged: ["nome"] });
  });
});

describe("logTentativaAcesso / logAcessoNegado (LGPD 05-03)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetAnchorCache();
    mockPrisma.auditLog.create.mockImplementation(async ({ data }: any) => data);
    tenantComAncora(null);
  });

  it("grava a tentativa com ação própria, alvo User e os detalhes recebidos", async () => {
    await logTentativaAcesso({ tenantId: "t1", userId: "u1", action: "LOGIN_FALHA", details: { email: "jo***@x.com", motivo: "SENHA_INVALIDA" } });

    const { data } = mockPrisma.auditLog.create.mock.calls[0][0];
    expect(data).toMatchObject({ tenantId: "t1", userId: "u1", action: "LOGIN_FALHA", target: "User", targetId: "u1" });
  });

  it("falha ao gravar a auditoria não derruba quem chamou", async () => {
    const erro = jest.spyOn(console, "error").mockImplementation(() => undefined);
    mockPrisma.auditLog.create.mockRejectedValue(new Error("db fora"));

    await expect(logTentativaAcesso({ tenantId: "t1", action: "2FA_FALHA", details: {} })).resolves.toBeUndefined();
    erro.mockRestore();
  });

  it("403 por papel: grava rota sem query string, papel e papéis exigidos", async () => {
    await logAcessoNegado({ id: "u1", tenantId: "t1", role: "VIEWER" }, "GET", "/api/users?email=a@b.com", ["ADMIN"]);

    const { data } = mockPrisma.auditLog.create.mock.calls[0][0];
    expect(data.action).toBe("ACESSO_NEGADO");
    expect(data.details).toEqual({ metodo: "GET", rota: "/api/users", papel: "VIEWER", papeisExigidos: ["ADMIN"] });
  });
});

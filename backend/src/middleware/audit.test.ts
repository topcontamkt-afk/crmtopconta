/**
 * Testes unitários com Prisma mockado (mesmo padrão do resto do repo). Foco: logAudit()
 * encadeia corretamente cada nova entrada no hash-chain (achado #11), sem exercitar
 * verifyAuditChain() em si (coberto em services/auditIntegrity.test.ts).
 */

jest.mock("../config/db", () => ({
  prisma: {
    auditLog: { create: jest.fn(), findFirst: jest.fn() },
  },
}));

import { prisma } from "../config/db";
import { logAudit } from "./audit";

const mockPrisma = prisma as unknown as {
  auditLog: { create: jest.Mock; findFirst: jest.Mock };
};

describe("logAudit — hash-chain", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.auditLog.create.mockImplementation(async ({ data }: any) => data);
  });

  it("primeira entrada da cadeia (nenhuma anterior) grava prevHash null e um hash", async () => {
    mockPrisma.auditLog.findFirst.mockResolvedValue(null);

    await logAudit({ tenantId: "t1", userId: "u1", action: "TEST", target: "X", targetId: "x1", details: { a: 1 } });

    const { data } = mockPrisma.auditLog.create.mock.calls[0][0];
    expect(data.prevHash).toBeNull();
    expect(typeof data.hash).toBe("string");
    expect(data.hash.length).toBeGreaterThan(0);
  });

  it("encadeia com o hash da última entrada existente", async () => {
    mockPrisma.auditLog.findFirst.mockResolvedValue({ hash: "hash-anterior" });

    await logAudit({ tenantId: "t1", action: "TEST2" });

    const { data } = mockPrisma.auditLog.create.mock.calls[0][0];
    expect(data.prevHash).toBe("hash-anterior");
  });

  it("duas ações diferentes produzem hashes diferentes", async () => {
    mockPrisma.auditLog.findFirst.mockResolvedValue(null);

    await logAudit({ tenantId: "t1", action: "A" });
    await logAudit({ tenantId: "t1", action: "B" });

    const hash1 = mockPrisma.auditLog.create.mock.calls[0][0].data.hash;
    const hash2 = mockPrisma.auditLog.create.mock.calls[1][0].data.hash;
    expect(hash1).not.toBe(hash2);
  });

  it("não loga PII crua além do que já era passado — só encadeia o que o chamador enviou", async () => {
    mockPrisma.auditLog.findFirst.mockResolvedValue(null);

    await logAudit({ tenantId: "t1", action: "UPDATE_CLIENT", details: { fieldsChanged: ["nome"] } });

    const { data } = mockPrisma.auditLog.create.mock.calls[0][0];
    expect(data.details).toEqual({ fieldsChanged: ["nome"] });
  });
});

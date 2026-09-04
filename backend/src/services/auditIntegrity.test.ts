/**
 * Testes unitários com Prisma mockado (mesmo padrão de retention.test.ts/masking.test.ts — sem
 * integração real com DB neste repo).
 */

jest.mock("../config/db", () => ({
  prisma: {
    auditLog: { findFirst: jest.fn(), findMany: jest.fn() },
  },
}));

import { prisma } from "../config/db";
import { computeAuditHash, verifyAuditChain, type AuditEntryForHash } from "./auditIntegrity";

const mockPrisma = prisma as unknown as {
  auditLog: { findFirst: jest.Mock; findMany: jest.Mock };
};

describe("computeAuditHash", () => {
  const base: AuditEntryForHash = {
    tenantId: "t1",
    userId: "u1",
    action: "A",
    target: "T",
    targetId: "id1",
    details: { a: 1, b: 2 },
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  it("é determinístico para a mesma entrada", () => {
    expect(computeAuditHash(base, null)).toBe(computeAuditHash(base, null));
  });

  it("muda se qualquer campo mudar", () => {
    expect(computeAuditHash(base, null)).not.toBe(computeAuditHash({ ...base, action: "B" }, null));
  });

  it("é independente da ordem das chaves em details (serialização canônica)", () => {
    const h1 = computeAuditHash({ ...base, details: { a: 1, b: 2 } }, null);
    const h2 = computeAuditHash({ ...base, details: { b: 2, a: 1 } }, null);
    expect(h1).toBe(h2);
  });

  it("depende do prevHash", () => {
    expect(computeAuditHash(base, "x")).not.toBe(computeAuditHash(base, "y"));
  });
});

describe("verifyAuditChain", () => {
  beforeEach(() => jest.clearAllMocks());

  function buildChain(entries: AuditEntryForHash[]) {
    let prevHash: string | null = null;
    return entries.map((e, i) => {
      const hash = computeAuditHash(e, prevHash);
      const row = { id: `row-${i}`, ...e, prevHash, hash };
      prevHash = hash;
      return row;
    });
  }

  const entryAt = (action: string, minute: number): AuditEntryForHash => ({
    tenantId: "t1",
    userId: "u1",
    action,
    target: null,
    targetId: null,
    details: null,
    createdAt: new Date(2026, 0, 1, 0, minute),
  });

  it("cadeia íntegra → valid true, conta todas as entradas", async () => {
    const rows = buildChain([entryAt("A", 0), entryAt("B", 1), entryAt("C", 2)]);
    mockPrisma.auditLog.findMany.mockResolvedValue(rows);

    await expect(verifyAuditChain()).resolves.toEqual({ valid: true, checked: 3 });
  });

  it("detecta adulteração no meio da cadeia e aponta a linha exata", async () => {
    const rows = buildChain([entryAt("A", 0), entryAt("B", 1), entryAt("C", 2)]);
    rows[1].action = "ADULTERADO"; // conteúdo mudado sem recalcular o hash
    mockPrisma.auditLog.findMany.mockResolvedValue(rows);

    const result = await verifyAuditChain();
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.brokenAt.id).toBe("row-1");
  });

  it("detecta remoção de uma linha do meio (quebra o encadeamento de prevHash)", async () => {
    const rows = buildChain([entryAt("A", 0), entryAt("B", 1), entryAt("C", 2)]);
    rows.splice(1, 1); // remove a linha do meio, como um DELETE direto no banco faria
    mockPrisma.auditLog.findMany.mockResolvedValue(rows);

    const result = await verifyAuditChain();
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.brokenAt.id).toBe("row-2");
  });

  it("cadeia vazia (só entradas pré-hash-chain, já filtradas pela query) → valid true, checked 0", async () => {
    mockPrisma.auditLog.findMany.mockResolvedValue([]);
    await expect(verifyAuditChain()).resolves.toEqual({ valid: true, checked: 0 });
  });
});

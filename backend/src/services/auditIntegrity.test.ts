/**
 * Testes unitários com Prisma mockado (mesmo padrão de retention.test.ts/masking.test.ts — sem
 * integração real com DB neste repo).
 */

jest.mock("../config/db", () => ({
  prisma: {
    auditLog: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn() },
  },
}));

import { prisma } from "../config/db";
import {
  ACAO_REDACAO_AUDITORIA,
  ANCORA_CADEIA_TENANT,
  registroRedacao,
  computeAuditHash,
  getLastAuditHash,
  prepareTenantChain,
  resetAnchorCache,
  verifyAuditChain,
  type AuditEntryForHash,
} from "./auditIntegrity";

const mockPrisma = prisma as unknown as {
  auditLog: { findFirst: jest.Mock; findMany: jest.Mock; create: jest.Mock };
};

type Row = AuditEntryForHash & { id: string; prevHash: string | null; hash: string };

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

let seq = 0;
const entryAt = (tenantId: string, action: string, minute: number, details: unknown = null): AuditEntryForHash => ({
  tenantId,
  userId: "u1",
  action,
  target: null,
  targetId: null,
  details,
  createdAt: new Date(2026, 0, 1, 0, minute),
});

/** Encadeia `entries` a partir de `prevHash` (era global ou cadeia de um tenant). */
function chain(entries: AuditEntryForHash[], prevHash: string | null = null): Row[] {
  return entries.map((e) => {
    const hash = computeAuditHash(e, prevHash);
    const row = { id: `row-${seq++}`, ...e, prevHash, hash };
    prevHash = hash;
    return row;
  });
}

/** Âncora como prepareTenantChain grava: prevHash = último do tenant, legado selado em details. */
function anchorAfter(tenantId: string, legado: Row[], minute: number): Row {
  const ultimo = legado.length ? legado[legado.length - 1].hash : null;
  return chain([entryAt(tenantId, ANCORA_CADEIA_TENANT, minute, { legadoTotal: legado.length, legadoUltimoHash: ultimo })], ultimo)[0];
}

/** O que o banco devolveria para `where: { tenantId }`, ordenado por createdAt. */
const only = (rows: Row[], tenantId: string) =>
  rows.filter((r) => r.tenantId === tenantId).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

describe("verifyAuditChain — cadeia por tenant (LGPD 08-08)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("lê só as linhas do tenant pedido", async () => {
    mockPrisma.auditLog.findMany.mockResolvedValue([]);
    await verifyAuditChain("t1");
    expect(mockPrisma.auditLog.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", hash: { not: null } });
  });

  it("cadeia íntegra (âncora sem legado + entradas) → valid true, conta todas", async () => {
    const a = anchorAfter("t1", [], 0);
    const rows = [a, ...chain([entryAt("t1", "A", 1), entryAt("t1", "B", 2)], a.hash)];
    mockPrisma.auditLog.findMany.mockResolvedValue(rows);

    await expect(verifyAuditChain("t1")).resolves.toEqual({ valid: true, checked: 3, ancora: true, lacunasLegado: 0, redigidas: 0 });
  });

  it("detecta adulteração no meio da cadeia e aponta a linha exata", async () => {
    const a = anchorAfter("t1", [], 0);
    const rows = [a, ...chain([entryAt("t1", "A", 1), entryAt("t1", "B", 2), entryAt("t1", "C", 3)], a.hash)];
    rows[2].action = "ADULTERADO"; // conteúdo mudado sem recalcular o hash
    mockPrisma.auditLog.findMany.mockResolvedValue(rows);

    const result = await verifyAuditChain("t1");
    expect(result).toMatchObject({ valid: false, motivo: "CONTEUDO", brokenAt: { id: rows[2].id } });
  });

  it("detecta remoção de uma linha do meio (quebra o encadeamento de prevHash)", async () => {
    const a = anchorAfter("t1", [], 0);
    const rows = [a, ...chain([entryAt("t1", "A", 1), entryAt("t1", "B", 2), entryAt("t1", "C", 3)], a.hash)];
    const depois = rows[3];
    rows.splice(2, 1); // DELETE direto no banco
    mockPrisma.auditLog.findMany.mockResolvedValue(rows);

    const result = await verifyAuditChain("t1");
    expect(result).toMatchObject({ valid: false, motivo: "ELO", brokenAt: { id: depois.id } });
  });

  it("cadeia vazia (só entradas pré-hash-chain, já filtradas pela query) → valid true, checked 0", async () => {
    mockPrisma.auditLog.findMany.mockResolvedValue([]);
    await expect(verifyAuditChain("t1")).resolves.toEqual({ valid: true, checked: 0, ancora: false, lacunasLegado: 0, redigidas: 0 });
  });

  it("eliminar os dados de OUTRO tenant não afeta a verificação deste (antes quebrava para todos)", async () => {
    const a1 = anchorAfter("t1", [], 0);
    const a2 = anchorAfter("t2", [], 1);
    const t1 = [a1, ...chain([entryAt("t1", "A", 2), entryAt("t1", "B", 4)], a1.hash)];
    chain([entryAt("t2", "X", 3)], a2.hash); // t2 apagado: o banco não devolve nada dele
    mockPrisma.auditLog.findMany.mockResolvedValue(only(t1, "t1"));

    await expect(verifyAuditChain("t1")).resolves.toMatchObject({ valid: true, checked: 3 });
  });

  describe("transição da cadeia global para a por tenant", () => {
    // Era global: t1 e t2 intercalados numa cadeia só (prevHash aponta para a linha anterior de qualquer tenant).
    function legadoGlobal() {
      return chain([
        entryAt("t1", "L1", 0),
        entryAt("t2", "L2", 1),
        entryAt("t1", "L3", 2),
        entryAt("t1", "L4", 3),
        entryAt("t2", "L5", 4),
        entryAt("t1", "L6", 5),
      ]);
    }

    it("legado intercalado com outro tenant + âncora + cadeia nova → valid true, sem falso alarme", async () => {
      const global = legadoGlobal();
      const legadoT1 = only(global, "t1");
      const a = anchorAfter("t1", legadoT1, 10);
      const novas = chain([entryAt("t1", "N1", 11), entryAt("t1", "N2", 12)], a.hash);
      mockPrisma.auditLog.findMany.mockResolvedValue([...legadoT1, a, ...novas]);

      const result = await verifyAuditChain("t1");
      // L3 e L6 apontam para linhas de t2 (lacunas legadas); L1 é o início da cadeia global.
      expect(result).toEqual({ valid: true, checked: 7, ancora: true, lacunasLegado: 2, redigidas: 0 });
    });

    it("tenant que ainda não gravou desde o deploy (sem âncora): legado conferido sem falso alarme", async () => {
      mockPrisma.auditLog.findMany.mockResolvedValue(only(legadoGlobal(), "t2"));
      await expect(verifyAuditChain("t2")).resolves.toEqual({ valid: true, checked: 2, ancora: false, lacunasLegado: 2, redigidas: 0 });
    });

    it("adulteração de conteúdo no legado continua detectada", async () => {
      const legadoT1 = only(legadoGlobal(), "t1");
      const a = anchorAfter("t1", legadoT1, 10);
      legadoT1[1].targetId = "outro";
      mockPrisma.auditLog.findMany.mockResolvedValue([...legadoT1, a]);

      await expect(verifyAuditChain("t1")).resolves.toMatchObject({ valid: false, motivo: "CONTEUDO", brokenAt: { id: legadoT1[1].id } });
    });

    it("remover uma linha do legado depois da âncora é detectado pela âncora (total selado)", async () => {
      const legadoT1 = only(legadoGlobal(), "t1");
      const a = anchorAfter("t1", legadoT1, 10);
      legadoT1.splice(1, 1);
      mockPrisma.auditLog.findMany.mockResolvedValue([...legadoT1, a]);

      await expect(verifyAuditChain("t1")).resolves.toMatchObject({ valid: false, motivo: "ANCORA", brokenAt: { id: a.id } });
    });

    it("remover a última linha do legado é detectado (elo da âncora)", async () => {
      const legadoT1 = only(legadoGlobal(), "t1");
      const a = anchorAfter("t1", legadoT1, 10);
      legadoT1.pop();
      mockPrisma.auditLog.findMany.mockResolvedValue([...legadoT1, a]);

      await expect(verifyAuditChain("t1")).resolves.toMatchObject({ valid: false, motivo: "ANCORA" });
    });

    it("linha encadeada no modo global depois da âncora aparece como quebra", async () => {
      const legadoT1 = only(legadoGlobal(), "t1");
      const a = anchorAfter("t1", legadoT1, 10);
      const intrusa = chain([entryAt("t1", "GLOBAL_TARDIA", 11)], "hash-de-outro-tenant")[0];
      mockPrisma.auditLog.findMany.mockResolvedValue([...legadoT1, a, intrusa]);

      await expect(verifyAuditChain("t1")).resolves.toMatchObject({ valid: false, motivo: "ELO", brokenAt: { id: intrusa.id } });
    });
  });
});

// LGPD 04-01: a retenção tira PII de `details` antigos sem quebrar a prova de integridade
describe("verifyAuditChain — redação de PII registrada como evento encadeado", () => {
  beforeEach(() => jest.clearAllMocks());

  function cenario() {
    const a = anchorAfter("t1", [], 0);
    const [upd, outra] = chain(
      [
        { ...entryAt("t1", "UPDATE_CLIENT", 1, { nome: "João Silva", telefone: "+5584999998888", statusConta: "ATIVO" }), target: "Client", targetId: "c1" },
        entryAt("t1", "B", 2),
      ],
      a.hash
    );
    const redigido = { nome: "[redacted-anonimizacao]", telefone: "[redacted-anonimizacao]", statusConta: "ATIVO" };
    return { a, upd, outra, redigido };
  }

  it("linha reescrita coberta por um evento de redação posterior → cadeia íntegra, sem PII", async () => {
    const { a, upd, outra, redigido } = cenario();
    const evento = chain([entryAt("t1", ACAO_REDACAO_AUDITORIA, 3, { linhas: [registroRedacao(upd, redigido)] })], outra.hash)[0];
    const reescrita = { ...upd, details: redigido };
    mockPrisma.auditLog.findMany.mockResolvedValue([a, reescrita, outra, evento]);

    await expect(verifyAuditChain("t1")).resolves.toEqual({ valid: true, checked: 4, ancora: true, lacunasLegado: 0, redigidas: 1 });
    expect(JSON.stringify([a, reescrita, outra, evento])).not.toContain("99998888");
  });

  it("sem o evento (como a retenção antiga fazia), reescrever details quebra a cadeia (CONTEUDO)", async () => {
    const { a, upd, outra, redigido } = cenario();
    mockPrisma.auditLog.findMany.mockResolvedValue([a, { ...upd, details: redigido }, outra]);
    await expect(verifyAuditChain("t1")).resolves.toMatchObject({ valid: false, motivo: "CONTEUDO", brokenAt: { id: upd.id } });
  });

  it("conteúdo diferente do selado ou metadado alterado continuam sendo adulteração", async () => {
    const { a, upd, outra, redigido } = cenario();
    const evento = chain([entryAt("t1", ACAO_REDACAO_AUDITORIA, 3, { linhas: [registroRedacao(upd, redigido)] })], outra.hash)[0];

    mockPrisma.auditLog.findMany.mockResolvedValue([a, { ...upd, details: { ...redigido, statusConta: "BLOQUEADO" } }, outra, evento]);
    await expect(verifyAuditChain("t1")).resolves.toMatchObject({ valid: false, motivo: "CONTEUDO" });

    mockPrisma.auditLog.findMany.mockResolvedValue([a, { ...upd, details: redigido, targetId: "c2" }, outra, evento]);
    await expect(verifyAuditChain("t1")).resolves.toMatchObject({ valid: false, motivo: "CONTEUDO" });

  });
});

describe("getLastAuditHash / prepareTenantChain (LGPD 08-08)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetAnchorCache();
    mockPrisma.auditLog.create.mockImplementation(async ({ data }: any) => data);
  });

  it("getLastAuditHash filtra pelo tenant (sem leitura cross-tenant)", async () => {
    mockPrisma.auditLog.findFirst.mockResolvedValue({ hash: "h", createdAt: new Date() });
    await expect(getLastAuditHash("t1")).resolves.toBe("h");
    expect(mockPrisma.auditLog.findFirst.mock.calls[0][0].where).toEqual({ tenantId: "t1", hash: { not: null } });
  });

  it("sem âncora: grava a âncora selando o legado do tenant e devolve o elo dela", async () => {
    const ultimoLegado = new Date("2026-10-01T10:00:00.000Z");
    mockPrisma.auditLog.findFirst
      .mockResolvedValueOnce(null) // procura âncora
      .mockResolvedValueOnce({ hash: "ultimo-legado-t1", createdAt: ultimoLegado }); // último do tenant
    mockPrisma.auditLog.findMany.mockResolvedValueOnce([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]);

    const tip = await prepareTenantChain("t1");

    expect(mockPrisma.auditLog.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", hash: { not: null } });
    const { data } = mockPrisma.auditLog.create.mock.calls[0][0];
    expect(data).toMatchObject({
      tenantId: "t1",
      action: ANCORA_CADEIA_TENANT,
      prevHash: "ultimo-legado-t1",
      details: { legadoTotal: 4, legadoUltimoHash: "ultimo-legado-t1" },
    });
    expect(data.createdAt.getTime()).toBeGreaterThan(ultimoLegado.getTime());
    expect(tip).toEqual({ hash: data.hash, createdAt: data.createdAt });
  });

  it("com âncora: não grava outra e devolve o último elo do tenant; depois usa o cache", async () => {
    mockPrisma.auditLog.findFirst
      .mockResolvedValueOnce({ id: "ancora" })
      .mockResolvedValueOnce({ hash: "h1", createdAt: new Date() })
      .mockResolvedValueOnce({ hash: "h2", createdAt: new Date() });

    await expect(prepareTenantChain("t1")).resolves.toMatchObject({ hash: "h1" });
    await expect(prepareTenantChain("t1")).resolves.toMatchObject({ hash: "h2" });
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.findFirst).toHaveBeenCalledTimes(3); // âncora procurada só uma vez
  });

  it("a âncora gravada por prepareTenantChain fecha com verifyAuditChain", async () => {
    const legado = chain([entryAt("t1", "L1", 0), entryAt("t1", "L2", 1)], "hash-global-de-t2");
    mockPrisma.auditLog.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ hash: legado[1].hash, createdAt: legado[1].createdAt });
    mockPrisma.auditLog.findMany.mockResolvedValueOnce(legado.map((l) => ({ id: l.id })));
    await prepareTenantChain("t1");
    const ancora = { id: "ancora", ...mockPrisma.auditLog.create.mock.calls[0][0].data };

    mockPrisma.auditLog.findMany.mockResolvedValue([...legado, ancora]);
    await expect(verifyAuditChain("t1")).resolves.toEqual({ valid: true, checked: 3, ancora: true, lacunasLegado: 1, redigidas: 0 });
  });
});

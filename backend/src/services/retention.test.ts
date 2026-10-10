/**
 * Testes unitários com Prisma mockado (não há integração real com DB neste repo — ver
 * masking.test.ts/segments.test.ts para o mesmo padrão de testes puros). O foco aqui é a
 * cascata de redação de PII em AuditLog (Parte B da anonimização por retenção — LGPD),
 * já que a anonimização do próprio Client em si é lógica simples e direta.
 */

jest.mock("../config/db", () => ({
  prisma: {
    tenant: { findMany: jest.fn() },
    client: { findMany: jest.fn(), update: jest.fn() },
    // findFirst: usado por logAudit() (via getLastAuditHash(), hash-chain — achado #11) toda
    // vez que o sweep registra a própria ação de anonimização no AuditLog.
    auditLog: { findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
  },
}));

import { prisma } from "../config/db";
import { runRetentionSweep } from "./retention";

type FakeAuditLog = {
  id: string;
  tenantId: string;
  target: string | null;
  targetId: string | null;
  details: Record<string, unknown> | null;
};

const mockPrisma = prisma as unknown as {
  tenant: { findMany: jest.Mock };
  client: { findMany: jest.Mock; update: jest.Mock };
  auditLog: { findMany: jest.Mock; findFirst: jest.Mock; update: jest.Mock; create: jest.Mock };
};

const REDACTED = "[redacted-anonimizacao]";

describe("runRetentionSweep — cascata de redação de PII em AuditLog", () => {
  let fakeAuditLogs: FakeAuditLog[];

  beforeEach(() => {
    jest.clearAllMocks();

    // client-1 é o único candidato retornado por este sweep (simulando que só ele passou do
    // cutoff de retenção); client-2 nunca aparece como candidato — usado abaixo para provar
    // que entradas de AuditLog de OUTRO cliente não são tocadas.
    mockPrisma.tenant.findMany.mockResolvedValue([{ id: "tenant-1", retentionDays: 90 }]);
    mockPrisma.client.findMany.mockResolvedValue([
      { id: "client-1", tenantId: "tenant-1", dataUltimaUtilizacao: null, createdAt: new Date("2020-01-01") },
    ]);
    mockPrisma.client.update.mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data }));
    mockPrisma.auditLog.create.mockResolvedValue({ id: "new-log" });
    mockPrisma.auditLog.findFirst.mockResolvedValue(null); // hash-chain: sem entrada anterior nestes testes

    fakeAuditLogs = [
      // Entrada pré-existente (antes do fix da Parte A) com PII bruta no details — deve ser
      // redigida, preservando o campo não-PII (statusConta).
      {
        id: "log-1",
        tenantId: "tenant-1",
        target: "Client",
        targetId: "client-1",
        details: { nome: "João Silva", telefone: "+5511999999999", cidade: "São Paulo", statusConta: "ATIVO" },
      },
      // Entrada já no formato pós-fix da Parte A (sem chaves PII) — não deve gerar update.
      {
        id: "log-2",
        tenantId: "tenant-1",
        target: "Client",
        targetId: "client-1",
        details: { fieldsChanged: ["statusConta"] },
      },
      // Entrada de OUTRO cliente (client-2), não anonimizado neste sweep — não deve ser tocada.
      {
        id: "log-3",
        tenantId: "tenant-1",
        target: "Client",
        targetId: "client-2",
        details: { nome: "Maria Souza", telefone: "+5511888888888" },
      },
      // Entrada de outro tipo de target (Campaign) — nunca corresponde à query por
      // target="Client", não deve ser tocada.
      {
        id: "log-4",
        tenantId: "tenant-1",
        target: "Campaign",
        targetId: "campaign-1",
        details: { phoneCount: 3 },
      },
    ];

    mockPrisma.auditLog.findMany.mockImplementation(async ({ where }: any) =>
      fakeAuditLogs
        .filter((l) => l.tenantId === where.tenantId && l.target === where.target && l.targetId === where.targetId)
        .map((l) => ({ id: l.id, details: l.details }))
    );
    mockPrisma.auditLog.update.mockImplementation(async ({ where, data }: any) => {
      const log = fakeAuditLogs.find((l) => l.id === where.id);
      if (log) log.details = data.details;
      return log;
    });
  });

  it("redige apenas os campos PII de AuditLog.details do cliente anonimizado, sem apagar a linha", async () => {
    const result = await runRetentionSweep(prisma as any);

    expect(result.totalAnonymized).toBe(1);
    expect(result.auditLogsRedacted).toBe(1);

    // log-1 (do cliente anonimizado, com PII bruta): PII redigida...
    expect(fakeAuditLogs[0].details).toEqual({
      nome: REDACTED,
      telefone: REDACTED,
      cidade: REDACTED,
      statusConta: "ATIVO", // ...campo não-PII preservado
    });

    // A linha continua existindo (não foi deletada) — só o conteúdo de `details` mudou.
    expect(mockPrisma.auditLog.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.auditLog.update).toHaveBeenCalledWith({
      where: { id: "log-1" },
      data: { details: expect.any(Object) },
    });
  });

  it("não altera AuditLog já sem PII (formato pós-fix da Parte A)", async () => {
    await runRetentionSweep(prisma as any);

    expect(fakeAuditLogs[1].details).toEqual({ fieldsChanged: ["statusConta"] });
  });

  it("não altera AuditLog de outros clientes/targets", async () => {
    await runRetentionSweep(prisma as any);

    expect(fakeAuditLogs[2].details).toEqual({ nome: "Maria Souza", telefone: "+5511888888888" });
    expect(fakeAuditLogs[3].details).toEqual({ phoneCount: 3 });
  });

  it("consulta AuditLog sempre escopado por tenantId (defesa em profundidade do tenantGuard)", async () => {
    await runRetentionSweep(prisma as any);

    expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1", target: "Client", targetId: "client-1" },
      select: { id: true, details: true },
    });
  });

  it("continua anonimizando os campos PII da própria linha de Client", async () => {
    await runRetentionSweep(prisma as any);

    expect(mockPrisma.client.update).toHaveBeenCalledWith({
      where: { id: "client-1" },
      data: expect.objectContaining({
        nome: "Cliente anonimizado",
        telefone: "anon-client-1",
        cpfHash: "anon-client-1",
        cpfMasked: "***.***.***-**",
        cidade: null,
        tags: [],
      }),
    });
  });

  it("não redige nada e não chama update quando o cliente não tem AuditLog relacionado", async () => {
    fakeAuditLogs = [];
    mockPrisma.auditLog.findMany.mockResolvedValue([]);

    const result = await runRetentionSweep(prisma as any);

    expect(result.totalAnonymized).toBe(1);
    expect(result.auditLogsRedacted).toBe(0);
    expect(mockPrisma.auditLog.update).not.toHaveBeenCalled();
  });
});

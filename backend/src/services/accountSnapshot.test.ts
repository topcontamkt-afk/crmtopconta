import { hasAccountChanged, recordAccountSnapshots, SnapshotCandidate } from "./accountSnapshot";

const NOW = new Date("2026-10-10T12:00:00Z");

const state = (over: Partial<SnapshotCandidate["current"]> = {}): SnapshotCandidate["current"] => ({
  limiteTotal: 2000,
  saldoDisponivel: 1500,
  valorUtilizado: 500,
  statusConta: "ATIVO",
  ...over,
});
const prev = (over: Partial<NonNullable<SnapshotCandidate["previous"]>> = {}) => ({
  limiteTotal: 2000,
  saldoDisponivel: 1500,
  statusConta: "ATIVO" as const,
  ...over,
});

describe("hasAccountChanged", () => {
  it("cliente novo (sem estado anterior) sempre conta como mudança", () => {
    expect(hasAccountChanged(undefined, state())).toBe(true);
  });

  it("sem mudança em saldo, limite e status: nada a gravar", () => {
    expect(hasAccountChanged(prev(), state())).toBe(false);
  });

  it("detecta mudança de saldo, de limite e de status", () => {
    expect(hasAccountChanged(prev(), state({ saldoDisponivel: 1999.5 }))).toBe(true);
    expect(hasAccountChanged(prev(), state({ limiteTotal: 2500 }))).toBe(true);
    expect(hasAccountChanged(prev(), state({ statusConta: "BLOQUEADO" }))).toBe(true);
  });

  it("compara em centavos: 0.1 + 0.2 vs 0.3 não é mudança", () => {
    expect(hasAccountChanged(prev({ saldoDisponivel: 0.1 + 0.2 }), state({ saldoDisponivel: 0.3 }))).toBe(false);
  });

  it("mudança só em valorUtilizado não conta (é derivado de limite - saldo)", () => {
    expect(hasAccountChanged(prev(), state({ valorUtilizado: 777 }))).toBe(false);
  });
});

function makeFakePrisma(clientsWithHistory: string[] = [], failOn?: "find" | "create") {
  const created: any[] = [];
  const prisma: any = {
    accountSnapshot: {
      findMany: jest.fn(async ({ where }: any) => {
        if (failOn === "find") throw new Error("boom");
        expect(where.tenantId).toBe("t1");
        return where.clientId.in.filter((id: string) => clientsWithHistory.includes(id)).map((clientId: string) => ({ clientId }));
      }),
      createMany: jest.fn(async ({ data }: any) => {
        if (failOn === "create") throw new Error("boom");
        for (const row of data) expect(row.tenantId).toBe("t1");
        created.push(...data);
        return { count: data.length };
      }),
    },
  };
  return { prisma, created };
}

describe("recordAccountSnapshots", () => {
  let errSpy: jest.SpyInstance;
  beforeEach(() => {
    errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errSpy.mockRestore());

  it("grava a linha-base de cliente novo, com saldoAnterior nulo", async () => {
    const { prisma, created } = makeFakePrisma();
    const n = await recordAccountSnapshots(prisma, "t1", [{ clientId: "c1", current: state() }], "job1", NOW);
    expect(n).toBe(1);
    expect(created[0]).toMatchObject({
      clientId: "c1",
      saldoDisponivel: 1500,
      saldoAnterior: null,
      limiteTotal: 2000,
      statusConta: "ATIVO",
      importJobId: "job1",
      recordedAt: NOW,
    });
  });

  it("registra a renovação do limite: saldo volta e saldoAnterior guarda de onde veio", async () => {
    const { prisma, created } = makeFakePrisma(["c1"]);
    await recordAccountSnapshots(
      prisma,
      "t1",
      [{ clientId: "c1", previous: prev({ saldoDisponivel: 0.01 }), current: state({ saldoDisponivel: 2000, valorUtilizado: 0 }) }],
      "job1",
      NOW
    );
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ saldoAnterior: 0.01, saldoDisponivel: 2000 });
  });

  it("não grava quando nada mudou e o cliente já tem histórico", async () => {
    const { prisma, created } = makeFakePrisma(["c1"]);
    const n = await recordAccountSnapshots(prisma, "t1", [{ clientId: "c1", previous: prev(), current: state() }], "job1", NOW);
    expect(n).toBe(0);
    expect(created).toHaveLength(0);
  });

  it("grava a linha-base de cliente existente que ainda não tinha histórico, mesmo sem mudança", async () => {
    const { prisma, created } = makeFakePrisma([]); // c1 existia antes da tabela
    await recordAccountSnapshots(prisma, "t1", [{ clientId: "c1", previous: prev(), current: state() }], "job1", NOW);
    expect(created).toHaveLength(1);
    expect(created[0].saldoAnterior).toBe(1500);
  });

  it("mesmo cliente repetido no lote vira uma linha só (a última)", async () => {
    const { prisma, created } = makeFakePrisma();
    await recordAccountSnapshots(
      prisma,
      "t1",
      [
        { clientId: "c1", current: state({ saldoDisponivel: 100 }) },
        { clientId: "c1", current: state({ saldoDisponivel: 200 }) },
      ],
      "job1",
      NOW
    );
    expect(created).toHaveLength(1);
    expect(created[0].saldoDisponivel).toBe(200);
  });

  it("lista vazia não consulta o banco", async () => {
    const { prisma } = makeFakePrisma();
    expect(await recordAccountSnapshots(prisma, "t1", [], "job1", NOW)).toBe(0);
    expect(prisma.accountSnapshot.findMany).not.toHaveBeenCalled();
  });

  it.each(["find", "create"] as const)("falha do banco (%s) não lança: a importação segue", async (failOn) => {
    const { prisma } = makeFakePrisma([], failOn);
    await expect(recordAccountSnapshots(prisma, "t1", [{ clientId: "c1", current: state() }], "job1", NOW)).resolves.toBe(0);
  });
});

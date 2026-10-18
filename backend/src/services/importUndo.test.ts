import { assertUndoable, groupLotes, reviveBefore, undoLoteBatch, UndoError } from "./importUndo";

const T0 = new Date("2026-10-10T10:00:00Z");
const job = (over: Record<string, unknown> = {}) => ({ id: "j1", tenantId: "t1", loteId: "L1", formato: "cartoes", startedAt: T0, desfeitaEm: null, ...over });

function fake(opts: { jobs?: any[]; changes?: any[]; posterior?: any; clientUpdate?: (a: any) => any; clientDelete?: (a: any) => any; clientes?: any[]; eliminados?: string[] } = {}) {
  const changes = [...(opts.changes ?? [])];
  const log: Record<string, any[]> = { update: [], delete: [], movement: [], snap: [], jobUpdate: [] };
  const prisma: any = {
    importJob: {
      findMany: jest.fn(async ({ where }: any) => (opts.jobs ?? [job()]).filter((j) => (where.loteId ? j.loteId === where.loteId : where.id ? j.id === where.id : true))),
      findFirst: jest.fn(async () => opts.posterior ?? null),
      updateMany: jest.fn(async (a: any) => void log.jobUpdate.push(a)),
    },
    importChange: {
      count: jest.fn(async () => changes.length),
      findMany: jest.fn(async ({ take }: any) => changes.slice(0, take)),
      deleteMany: jest.fn(async ({ where }: any) => {
        for (const id of where.id.in) changes.splice(changes.findIndex((c) => c.id === id), 1);
      }),
    },
    client: {
      findMany: jest.fn(async ({ where }: any) => (opts.clientes ?? []).filter((c) => where.id.in.includes(c.id))),
      update: jest.fn(async (a: any) => { log.update.push(a); return opts.clientUpdate?.(a) ?? {}; }),
      delete: jest.fn(async (a: any) => { log.delete.push(a); return opts.clientDelete?.(a) ?? {}; }),
    },
    movement: { deleteMany: jest.fn(async (a: any) => void log.movement.push(a)) },
    supressaoTitular: { findMany: jest.fn(async ({ where }: any) => (opts.eliminados ?? []).filter((d) => where.docHash.in.includes(d)).map((docHash) => ({ docHash }))) },
    accountSnapshot: { deleteMany: jest.fn(async (a: any) => void log.snap.push(a)) },
  };
  return { prisma, log, changes };
}

describe("reviveBefore", () => {
  it("volta as datas de texto para Date e mantém o resto", () => {
    const r: any = reviveBefore({ dataCadastro: "2026-01-02T00:00:00.000Z", limiteTotal: "1500.00", nome: "Maria", encerradoEm: null });
    expect(r.dataCadastro).toBeInstanceOf(Date);
    expect(r.limiteTotal).toBe("1500.00");
    expect(r.encerradoEm).toBeNull();
  });
});

describe("assertUndoable", () => {
  it("recusa compras, já desfeita, não é a última e estado expirado", async () => {
    await expect(assertUndoable(fake({ jobs: [job({ formato: "compras" })] }).prisma, "t1", "L1")).rejects.toMatchObject({ codigo: "FORMATO_SEM_DESFAZER" });
    await expect(assertUndoable(fake({ jobs: [job({ desfeitaEm: new Date() })], changes: [{ id: "a" }] }).prisma, "t1", "L1")).rejects.toMatchObject({ codigo: "JA_DESFEITA" });
    await expect(assertUndoable(fake({ changes: [{ id: "a" }], posterior: { id: "j9" } }).prisma, "t1", "L1")).rejects.toMatchObject({ codigo: "NAO_E_A_ULTIMA" });
    await expect(assertUndoable(fake({ changes: [] }).prisma, "t1", "L1")).rejects.toMatchObject({ codigo: "EXPIRADA" });
    await expect(assertUndoable(fake({ jobs: [] }).prisma, "t1", "L9")).rejects.toBeInstanceOf(UndoError);
  });
});

describe("undoLoteBatch", () => {
  const ch = (id: string, kind: string, before: any = null) => ({ id, clientId: `c-${id}`, kind, before });

  it("restaura os atualizados, apaga os criados e fecha o lote ao zerar a fila", async () => {
    const { prisma, log } = fake({ changes: [ch("1", "ATUALIZADO", { limiteTotal: "1500.00", saldoDisponivel: "400.00", dataCadastro: "2026-01-02T00:00:00.000Z" }), ch("2", "CRIADO")] });
    const r = await undoLoteBatch(prisma, "t1", "u1", "L1");
    expect(r).toEqual({ restaurados: 1, protegidos: 0, removidos: 1, mantidos: 0, ausentes: 0, restantes: 0, concluido: true });
    expect(log.update[0].where).toEqual({ id: "c-1" });
    expect(log.update[0].data.limiteTotal).toBe("1500.00");
    expect(log.update[0].data.dataCadastro).toBeInstanceOf(Date);
    expect(log.delete[0].where).toEqual({ id: "c-2" });
    expect(log.movement[0].where).toMatchObject({ clientId: { in: ["c-1"] }, tipo: "renovacao_limite" });
    expect(log.snap.length).toBe(2); // do cliente criado e do lote inteiro
    expect(log.jobUpdate[0].data.desfeitaPor).toBe("u1");
  });

  it("processa em partes: enquanto sobra fila, o lote continua aberto", async () => {
    const lista = Array.from({ length: 5 }, (_, i) => ch(String(i), "ATUALIZADO", { nome: "x" }));
    const { prisma, log } = fake({ changes: lista });
    const a = await undoLoteBatch(prisma, "t1", "u1", "L1", 2);
    expect(a).toMatchObject({ restaurados: 2, restantes: 3, concluido: false });
    expect(log.jobUpdate).toHaveLength(0);
    const b = await undoLoteBatch(prisma, "t1", "u1", "L1", 10);
    expect(b).toMatchObject({ restaurados: 3, restantes: 0, concluido: true });
    expect(log.jobUpdate).toHaveLength(1);
  });

  it("cliente que sumiu ou que já tem histórico próprio não derruba o desfazer", async () => {
    const { prisma } = fake({
      changes: [ch("1", "ATUALIZADO", { nome: "x" }), ch("2", "CRIADO")],
      clientUpdate: () => { throw Object.assign(new Error("nf"), { code: "P2025" }); },
      clientDelete: () => { throw Object.assign(new Error("fk"), { code: "P2003" }); },
    });
    const r = await undoLoteBatch(prisma, "t1", "u1", "L1");
    expect(r).toMatchObject({ restaurados: 0, ausentes: 1, mantidos: 1, concluido: true });
  });
});

// LGPD 04-04: desfazer não pode trazer de volta nome/telefone/CPF de quem foi anonimizado depois da importação
describe("undoLoteBatch — nunca reidentifica", () => {
  const ch = (id: string, before: any) => ({ id, clientId: `c-${id}`, kind: "ATUALIZADO", before });
  const antes = { nome: "Maria Silva", telefone: "+5584999998888", cpfHash: "hash-real" };

  it("cliente anonimizado, bloqueado ou com documento eliminado não recebe o estado anterior", async () => {
    const { prisma, log } = fake({
      changes: [ch("1", antes), ch("2", antes), ch("3", { ...antes, cpfHash: "hash-eliminado" }), ch("4", { ...antes, cpfHash: "outro" })],
      clientes: [
        { id: "c-1", anonymizedAt: new Date(), bloqueadoLgpdAt: null, cpfHash: "anon-c-1" },
        { id: "c-2", anonymizedAt: null, bloqueadoLgpdAt: new Date(), cpfHash: "x" },
        { id: "c-3", anonymizedAt: null, bloqueadoLgpdAt: null, cpfHash: "y" },
        { id: "c-4", anonymizedAt: null, bloqueadoLgpdAt: null, cpfHash: "z" },
      ],
      eliminados: ["hash-eliminado"],
    });
    const r = await undoLoteBatch(prisma, "t1", "u1", "L1");
    expect(r).toMatchObject({ restaurados: 1, protegidos: 3, concluido: true });
    expect(log.update.map((u: any) => u.where.id)).toEqual(["c-4"]);
    expect(prisma.client.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: "t1" });
  });
});

describe("groupLotes", () => {
  it("uma linha por arquivo, somando as requisições", () => {
    const j = (id: string, over: any = {}) => ({ id, loteId: "L1", formato: "cartoes", nomeArquivo: "base.csv", source: "csv", status: "CONCLUIDO", startedAt: new Date(T0.getTime() + Number(id) * 1000), totalRows: 400, addedCount: 10, updatedCount: 390, errorCount: 0, desfeitaEm: null, ...over });
    const lotes = groupLotes([j("1"), j("2", { errorCount: 3 }), j("3", { loteId: null, formato: "compras", nomeArquivo: null })]);
    expect(lotes).toHaveLength(2);
    const l = lotes.find((x) => x.loteId === "L1")!;
    expect(l).toMatchObject({ totalRows: 800, addedCount: 20, updatedCount: 780, errorCount: 3, jobs: 2, status: "CONCLUIDO_COM_ERROS", nomeArquivo: "base.csv", desfeita: false });
    expect(lotes[0].loteId).toBe("3"); // mais recente primeiro; job sem lote vira o próprio lote
  });
});

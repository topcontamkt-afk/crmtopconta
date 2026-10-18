import { runImport } from "./importService";
import { hashCPF } from "./masking";

const CPF = "529.982.247-25";
const SALT = "salt";

jest.mock("../middleware/audit", () => ({ logAudit: jest.fn(async () => undefined) }));

function fake(existing: any, opts: { supressoes?: any[]; tenant?: any } = {}) {
  const updates: any[] = [];
  const changes: any[] = [];
  const supressoes = [...(opts.supressoes ?? [])];
  const prisma: any = {
    tenant: { findUniqueOrThrow: jest.fn(async () => ({ cpfSalt: SALT, ...opts.tenant })), findUnique: jest.fn(async () => ({ cpfSalt: SALT })) },
    supressaoTitular: {
      findMany: jest.fn(async ({ where }: any) => supressoes.filter((r) => (where.docHash?.in ?? []).includes(r.docHash))),
      deleteMany: jest.fn(async () => ({ count: 1 })),
    },
    campaignRecipient: { findMany: jest.fn(async () => []) },
    importJob: { create: jest.fn(async ({ data }: any) => ({ id: "job1", ...data })), update: jest.fn(async () => ({})) },
    importChange: { createMany: jest.fn(async ({ data }: any) => void changes.push(...data)) },
    client: {
      findUnique: jest.fn(async () => existing),
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
      update: jest.fn(async (a: any) => void updates.push(a)),
      create: jest.fn(async () => ({ id: "novo" })),
    },
    movement: { create: jest.fn(async () => ({})) },
    notification: { create: jest.fn() },
  };
  return { prisma, updates, changes };
}

const existente = () => ({ id: "c1", limiteTotal: 1500, valorUtilizado: 1100, saldoDisponivel: 400, valorAntecipado: 50, statusConta: "ATIVO", autorizacaoComunicacao: true, optOutAt: null, nome: "Maria", telefone: "+5584999998888" });
const linha = { id_cliente: "9", nome: "Maria Silva", telefone: "(84) 99999-8888", cpf: CPF };

describe("runImport (genérico) — arquivo sem as colunas de limite/saldo/status", () => {
  it("não zera nem reautoriza quem já está na base", async () => {
    const { prisma, updates, changes } = fake(existente());
    await runImport(prisma, "t1", [linha], "u1", "csv", undefined, { loteId: "L1", nomeArquivo: "x.csv" });
    const data = updates[0].data;
    for (const campo of ["limiteTotal", "valorUtilizado", "saldoDisponivel", "valorAntecipado", "statusConta", "autorizacaoComunicacao", "percentualUtilizado", "faixaUso"]) {
      expect(data).not.toHaveProperty(campo);
    }
    expect(data.nome).toBe("Maria Silva");
    expect(prisma.importJob.create.mock.calls[0][0].data).toMatchObject({ formato: "generico", loteId: "L1", nomeArquivo: "x.csv" });
    expect(changes[0]).toMatchObject({ kind: "ATUALIZADO", loteId: "L1" });
    expect(changes[0].before).toMatchObject({ nome: "Maria" });
    expect(prisma.movement.create).not.toHaveBeenCalled();
  });

  it("com as colunas no arquivo, atualiza normalmente (inclusive o opt-out sticky)", async () => {
    const { prisma, updates } = fake({ ...existente(), optOutAt: new Date() });
    await runImport(prisma, "t1", [{ ...linha, limite_total: "2000", valor_utilizado: "500", saldo_disponivel: "1500", status_conta: "Ativo", autorizacao_comunicacao: "sim" }], "u1", "csv");
    const data = updates[0].data;
    expect(data.limiteTotal).toBe(2000);
    expect(data.saldoDisponivel).toBe(1500);
    expect(data.percentualUtilizado).toBe(25);
    expect(data.autorizacaoComunicacao).toBe(false); // quem saiu não volta
    expect(prisma.movement.create).toHaveBeenCalled(); // limite subiu
  });

  it("camposPresentes do arquivo inteiro vale mais que o lote", async () => {
    const { prisma, updates } = fake(existente());
    // este lote não tem limite, mas o arquivo tem (outro lote): o campo é considerado presente e vira zero se vazio
    await runImport(prisma, "t1", [linha], "u1", "csv", undefined, { camposPresentes: ["limite_total"] });
    expect(updates[0].data.limiteTotal).toBe(0);
    expect(updates[0].data).not.toHaveProperty("saldoDisponivel");
  });
});

// LGPD 03-01 / 03-03 / 03-04 no formato genérico (e Google Sheets)
describe("runImport (genérico) — LGPD", () => {
  const HASH = hashCPF(CPF, SALT);

  it("documento eliminado a pedido: linha ignorada (aviso, não erro); com abertura posterior volta como novo", async () => {
    const sup = { tenantId: "t1", docHash: HASH, motivo: "ELIMINACAO", createdAt: new Date("2026-10-01T00:00:00Z") };
    const a = fake(null, { supressoes: [sup] });
    const r = await runImport(a.prisma, "t1", [linha], "u1", "csv");
    expect(a.prisma.client.create).not.toHaveBeenCalled();
    expect(r.result.eliminadosAPedido).toBe(1);
    expect(a.prisma.importJob.update.mock.calls[0][0].data.status).toBe("CONCLUIDO");

    const b = fake(null, { supressoes: [sup] });
    const r2 = await runImport(b.prisma, "t1", [{ ...linha, data_abertura_conta: "2026-10-12" }], "u1", "csv");
    expect(b.prisma.client.create).toHaveBeenCalled();
    expect(b.prisma.supressaoTitular.deleteMany).toHaveBeenCalledWith({ where: { tenantId: "t1", motivo: "ELIMINACAO", docHash: HASH } });
    expect(r2.result.supressoesLiberadas).toBe(1);
  });

  it("cliente bloqueado não é atualizado; correção manual é preservada e contada", async () => {
    const bloqueado = fake({ ...existente(), bloqueadoLgpdAt: new Date() });
    const r = await runImport(bloqueado.prisma, "t1", [linha], "u1", "csv");
    expect(bloqueado.updates).toHaveLength(0);
    expect(r.result.bloqueadosLgpd).toBe(1);

    const corrigido = fake({ ...existente(), nome: "Maria Corrigida", camposCorrigidos: { nome: "2026-10-10" } }, { tenant: { correcaoManualVence: true } });
    const r2 = await runImport(corrigido.prisma, "t1", [linha], "u1", "csv");
    expect(corrigido.updates[0].data).not.toHaveProperty("nome");
    expect(r2.result.camposPreservadosCorrecao).toBe(1);
  });

  it("o fallback por telefone nunca casa com cliente anonimizado", async () => {
    const f = fake(null);
    await runImport(f.prisma, "t1", [linha], "u1", "csv");
    expect(f.prisma.client.findFirst.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", anonymizedAt: null });
  });
});


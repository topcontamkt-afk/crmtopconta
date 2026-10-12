import { runImport } from "./importService";
import { hashCPF } from "./masking";

const CPF = "529.982.247-25";
const SALT = "salt";

function fake(existing: any) {
  const updates: any[] = [];
  const changes: any[] = [];
  const prisma: any = {
    tenant: { findUniqueOrThrow: jest.fn(async () => ({ cpfSalt: SALT })) },
    importJob: { create: jest.fn(async ({ data }: any) => ({ id: "job1", ...data })), update: jest.fn(async () => ({})) },
    importChange: { createMany: jest.fn(async ({ data }: any) => void changes.push(...data)) },
    client: {
      findUnique: jest.fn(async () => existing),
      findFirst: jest.fn(async () => null),
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

void hashCPF;

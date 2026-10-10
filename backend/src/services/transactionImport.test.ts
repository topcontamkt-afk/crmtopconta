/**
 * Testes do importador de transações com um Prisma falso em memória (não há DB real neste repo —
 * ver retention.test.ts para o mesmo padrão). CPFs abaixo são fictícios com dígito verificador
 * válido (nenhum é de pessoa real).
 */
import { hashDocument } from "./masking";
import { prepareTransactionRow, relinkOrphanTransactions, runTransactionImport, TransactionRow } from "./transactionImport";

const SALT = "salt-teste";
const CPF_A = "529.982.247-25";
const CPF_B = "111.444.777-35";
const NOW = new Date("2026-10-10T12:00:00Z");

const pix = (over: Partial<TransactionRow> = {}): TransactionRow => ({
  id_transacao: "204493",
  data_confirmada: "15/09/2026 15:13:55",
  documento: CPF_A,
  descricao: "Débito Pix Cartão",
  nome_fantasia: "TopConta Cartão Antecipação",
  razao_social: "ARAUJO PROMOTORA LTDA",
  valor_parcela: "356,5",
  valor_principal: "310",
  juros: "46,5",
  ...over,
});

describe("prepareTransactionRow", () => {
  const prep = (raw: TransactionRow) => prepareTransactionRow(raw, 2, SALT, NOW);

  it("antecipação: valor movimentado = principal, lucro = juros, conta como uso", () => {
    const out = prep(pix());
    expect("prepared" in out).toBe(true);
    if (!("prepared" in out)) return;
    expect(out.prepared).toMatchObject({
      externalId: "204493",
      kind: "ANTECIPACAO",
      countsAsUsage: true,
      valorTotal: 356.5,
      valorPrincipal: 310,
      juros: 46.5,
    });
    expect(out.prepared.confirmedAt.toISOString()).toBe("2026-09-15T18:13:55.000Z");
  });

  it("nunca guarda o documento em claro: só o hash por tenant", () => {
    const out = prep(pix());
    if (!("prepared" in out)) throw new Error("esperava linha válida");
    expect(out.prepared.cpfHash).toBe(hashDocument(CPF_A, SALT));
    expect(JSON.stringify(out.prepared)).not.toContain("52998224725");
  });

  it("compra à vista: juros vazio vira zero (lucro desconhecido, não inventado)", () => {
    const out = prep(
      pix({ descricao: "Compra à Vista Cartão Top Convênio", valor_parcela: "1940", valor_principal: "1940", juros: "" })
    );
    if (!("prepared" in out)) throw new Error("esperava linha válida");
    expect(out.prepared).toMatchObject({ kind: "COMPRA", countsAsUsage: true, valorTotal: 1940, juros: 0 });
  });

  it("assinatura é guardada mas NÃO conta como uso", () => {
    const out = prep(
      pix({ descricao: "Assinatura AMEF-Gleebem", valor_parcela: "29,9", valor_principal: "29,9", juros: "0" })
    );
    if (!("prepared" in out)) throw new Error("esperava linha válida");
    expect(out.prepared).toMatchObject({ kind: "ASSINATURA", countsAsUsage: false });
  });

  it("deriva o valor que faltar: total = principal + juros", () => {
    const soPrincipal = prep(pix({ valor_parcela: undefined }));
    if (!("prepared" in soPrincipal)) throw new Error("esperava linha válida");
    expect(soPrincipal.prepared.valorTotal).toBe(356.5);

    const soTotal = prep(pix({ valor_principal: undefined }));
    if (!("prepared" in soTotal)) throw new Error("esperava linha válida");
    expect(soTotal.prepared.valorPrincipal).toBe(310);
  });

  it.each([
    ["id ausente", pix({ id_transacao: "" }), "id_transacao"],
    ["data ausente", pix({ data_confirmada: "" }), "data_confirmada"],
    ["descrição ausente", pix({ descricao: "" }), "descricao"],
    ["sem nenhum valor", pix({ valor_parcela: "", valor_principal: "" }), "valor_parcela ou valor_principal"],
    ["CPF inválido", pix({ documento: "529.982.247-26" }), "CPF/CNPJ inválido"],
    ["data ilegível", pix({ data_confirmada: "ontem" }), "Data de confirmação inválida"],
    ["data no futuro", pix({ data_confirmada: "20/12/2026 10:00:00" }), "no futuro"],
    ["valor ilegível", pix({ valor_parcela: "abc" }), "Valor inválido em valor_parcela"],
  ])("recusa a linha: %s", (_nome, raw, trecho) => {
    const out = prep(raw);
    expect("error" in out).toBe(true);
    if ("error" in out) expect(out.error.motivo).toContain(trecho);
  });

  it("recusa valor negativo ou zerado (possível estorno) em vez de contar como uso", () => {
    for (const raw of [
      pix({ valor_parcela: "-356,5", valor_principal: "-310" }),
      pix({ valor_parcela: "0", valor_principal: "0", juros: "0" }),
    ]) {
      const out = prep(raw);
      expect("error" in out).toBe(true);
      if ("error" in out) expect(out.error.motivo).toContain("estorno");
    }
  });
});

/** Prisma falso: guarda transações num Map respeitando a unicidade (tenantId, externalId). */
function makeFakePrisma(opts: { clients?: { id: string; cpfHash: string }[] } = {}) {
  const transactions: any[] = [];
  const clients = [...(opts.clients ?? [])];
  const jobUpdates: any[] = [];
  const notifications: any[] = [];

  const prisma: any = {
    tenant: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: "t1", cpfSalt: SALT }) },
    importJob: {
      create: jest.fn().mockResolvedValue({ id: "job1" }),
      update: jest.fn(async (args: any) => {
        jobUpdates.push(args.data);
        return args.data;
      }),
    },
    client: {
      findMany: jest.fn(async ({ where }: any) => clients.filter((c) => where.cpfHash.in.includes(c.cpfHash))),
    },
    transaction: {
      createMany: jest.fn(async ({ data, skipDuplicates }: any) => {
        expect(skipDuplicates).toBe(true);
        let count = 0;
        for (const row of data) {
          expect(row.tenantId).toBe("t1"); // toda linha criada carrega o tenant
          if (transactions.some((t) => t.tenantId === row.tenantId && t.externalId === row.externalId)) continue;
          transactions.push({ ...row });
          count++;
        }
        return { count };
      }),
      groupBy: jest.fn(async ({ where }: any) => {
        const orphans = transactions.filter((t) => t.tenantId === where.tenantId && t.clientId === null);
        return [...new Set(orphans.map((t) => t.cpfHash))].map((cpfHash) => ({ cpfHash }));
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const t of transactions) {
          if (t.tenantId === where.tenantId && t.cpfHash === where.cpfHash && t.clientId === null) {
            t.clientId = data.clientId;
            count++;
          }
        }
        return { count };
      }),
    },
    notification: { create: jest.fn(async (a: any) => notifications.push(a.data)) },
  };
  return { prisma, transactions, clients, jobUpdates, notifications };
}

describe("runTransactionImport", () => {
  // O importador valida "data no futuro" contra o relógio; fixa-o para os exemplos de 2026
  // continuarem válidos independente de quando o teste roda.
  beforeAll(() => {
    jest.useFakeTimers({ now: NOW });
  });
  afterAll(() => {
    jest.useRealTimers();
  });

  it("importa, liga ao cliente pelo hash e preenche o ImportJob", async () => {
    const hashA = hashDocument(CPF_A, SALT);
    const { prisma, transactions, jobUpdates } = makeFakePrisma({ clients: [{ id: "c1", cpfHash: hashA }] });

    const { result } = await runTransactionImport(prisma, "t1", [pix(), pix({ id_transacao: "204494" })], "u1");

    expect(result.addedCount).toBe(2);
    expect(result.duplicateCount).toBe(0);
    expect(transactions.map((t) => t.clientId)).toEqual(["c1", "c1"]);
    expect(jobUpdates[0]).toMatchObject({ status: "CONCLUIDO", addedCount: 2 });
  });

  it("é idempotente: reenviar o mesmo extrato não duplica nada", async () => {
    const { prisma, transactions } = makeFakePrisma({ clients: [{ id: "c1", cpfHash: hashDocument(CPF_A, SALT) }] });
    const rows = [pix(), pix({ id_transacao: "204494" })];

    await runTransactionImport(prisma, "t1", rows, "u1");
    const second = await runTransactionImport(prisma, "t1", rows, "u1");

    expect(transactions).toHaveLength(2);
    expect(second.result.addedCount).toBe(0);
    expect(second.result.duplicateCount).toBe(2);
  });

  it("extrato com sobreposição de dias só grava as transações novas", async () => {
    const { prisma, transactions } = makeFakePrisma({ clients: [{ id: "c1", cpfHash: hashDocument(CPF_A, SALT) }] });
    await runTransactionImport(prisma, "t1", [pix({ id_transacao: "1" }), pix({ id_transacao: "2" })], "u1");
    const { result } = await runTransactionImport(
      prisma,
      "t1",
      [pix({ id_transacao: "2" }), pix({ id_transacao: "3" })],
      "u1"
    );
    expect(result.addedCount).toBe(1);
    expect(result.duplicateCount).toBe(1);
    expect(transactions.map((t) => t.externalId)).toEqual(["1", "2", "3"]);
  });

  it("idTransacao repetida no mesmo arquivo conta uma vez", async () => {
    const { prisma, transactions } = makeFakePrisma();
    const { result } = await runTransactionImport(prisma, "t1", [pix(), pix()], "u1");
    expect(transactions).toHaveLength(1);
    expect(result.duplicateCount).toBe(1);
  });

  it("avisa uma vez por descrição desconhecida e não conta como uso", async () => {
    const { prisma, transactions } = makeFakePrisma({ clients: [{ id: "c1", cpfHash: hashDocument(CPF_A, SALT) }] });
    const { result } = await runTransactionImport(
      prisma,
      "t1",
      [
        pix({ id_transacao: "1", descricao: "Tarifa Nova" }),
        pix({ id_transacao: "2", descricao: "Tarifa Nova" }),
        pix({ id_transacao: "3" }),
      ],
      "u1"
    );
    const avisos = result.errors.filter((e) => e.motivo.includes("não reconhecida"));
    expect(avisos).toHaveLength(1);
    expect(avisos[0].motivo).toContain("2 transação(ões)");
    expect(transactions.filter((t) => t.kind === "OUTRO").every((t) => t.countsAsUsage === false)).toBe(true);
    expect(result.addedCount).toBe(3); // guardadas mesmo assim
  });

  it("cliente ainda não cadastrado: grava sem vínculo, avisa, e liga quando ele aparece", async () => {
    const { prisma, transactions, clients } = makeFakePrisma();

    const first = await runTransactionImport(prisma, "t1", [pix()], "u1");
    expect(transactions[0].clientId).toBeNull();
    expect(first.result.errors.some((e) => e.motivo.includes("não constam na base de contas"))).toBe(true);
    expect(first.result.errorCount).toBe(1);

    // a base de contas chega depois
    clients.push({ id: "c9", cpfHash: hashDocument(CPF_A, SALT) });
    const linked = await relinkOrphanTransactions(prisma, "t1");
    expect(linked).toBe(1);
    expect(transactions[0].clientId).toBe("c9");
  });

  it("relink não toca em transações de outro CPF nem já ligadas", async () => {
    const { prisma, transactions, clients } = makeFakePrisma({ clients: [{ id: "c1", cpfHash: hashDocument(CPF_A, SALT) }] });
    await runTransactionImport(
      prisma,
      "t1",
      [pix({ id_transacao: "1" }), pix({ id_transacao: "2", documento: CPF_B })],
      "u1"
    );
    expect(transactions.find((t) => t.externalId === "1")?.clientId).toBe("c1");
    expect(transactions.find((t) => t.externalId === "2")?.clientId).toBeNull();

    clients.push({ id: "c2", cpfHash: hashDocument(CPF_B, SALT) });
    expect(await relinkOrphanTransactions(prisma, "t1")).toBe(1);
    expect(transactions.find((t) => t.externalId === "1")?.clientId).toBe("c1");
    expect(transactions.find((t) => t.externalId === "2")?.clientId).toBe("c2");
  });

  it("status FALHOU e notificação quando todas as linhas são inválidas", async () => {
    const { prisma, jobUpdates, notifications } = makeFakePrisma();
    const { result } = await runTransactionImport(prisma, "t1", [pix({ documento: "000" }), pix({ id_transacao: "" })], "u1");
    expect(result.addedCount).toBe(0);
    expect(jobUpdates[0].status).toBe("FALHOU");
    expect(notifications[0]).toMatchObject({ type: "IMPORT_FAILED", tenantId: "t1" });
  });

  it("status CONCLUIDO_COM_ERROS quando só parte das linhas é inválida", async () => {
    const { prisma, jobUpdates } = makeFakePrisma({ clients: [{ id: "c1", cpfHash: hashDocument(CPF_A, SALT) }] });
    const { result } = await runTransactionImport(prisma, "t1", [pix(), pix({ id_transacao: "2", valor_parcela: "abc" })], "u1");
    expect(result.addedCount).toBe(1);
    expect(jobUpdates[0].status).toBe("CONCLUIDO_COM_ERROS");
  });
});

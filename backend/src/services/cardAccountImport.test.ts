import { parseNumber } from "./cardAccountImport";
import { normalizeDocumentDigits } from "./purchaseParsing";
import { isValidDocument } from "./masking";

describe("cardAccountImport — parsing tolerante", () => {
  it("lê valores no formato BR e no formato EUA", () => {
    expect(parseNumber("R$ 500,00")).toBe(500);
    expect(parseNumber("2.000,00")).toBe(2000);
    expect(parseNumber("2,000.00")).toBe(2000);
    expect(parseNumber("10.50")).toBe(10.5);
    expect(parseNumber("0.15")).toBe(0.15);
    expect(parseNumber("1,548.13")).toBe(1548.13);
    expect(parseNumber("R$ -")).toBe(0);
    expect(parseNumber("")).toBeUndefined();
  });

  it("recompõe o zero à esquerda do CPF perdido pela planilha", () => {
    const cpf = normalizeDocumentDigits("2698842547"); // 10 dígitos
    expect(cpf).toBe("02698842547");
    expect(normalizeDocumentDigits("71304029549")).toBe("71304029549");
  });
});

/* ───────────── proteção: o arquivo só altera o que traz ───────────── */
import { detectPresence, ignoredFields, planUpdate, previewCardAccountImport, runCardAccountImport, snapshotBefore, summarizeChange, ALL_PRESENT, CardAccountRow } from "./cardAccountImport";

const CPF_A = "529.982.247-25";
const CPF_B = "111.444.777-35";

function cliente(over: Record<string, unknown> = {}) {
  return {
    id: "c1", tenantId: "t1", cpfHash: "", nome: "Maria", telefone: "+5584999998888", limiteTotal: 1500, saldoDisponivel: 400, valorUtilizado: 1100,
    percentualUtilizado: 73, faixaUso: "USO_70", statusConta: "ATIVO", autorizacaoComunicacao: true, optOutAt: null, valorAntecipado: 120, origemCliente: null, ...over,
  } as any;
}

/** linha do arquivo de COMPRAS importado (por engano) como "Cartões e contas": só documento/nome/telefone mapeados */
const linhaDeCompras: CardAccountRow = { documento: CPF_A, nome: "Maria Silva", telefone: "(84) 99999-8888" };

describe("detectPresence", () => {
  it("coluna ausente ou vazia em todas as linhas = não traz", () => {
    const p = detectPresence([linhaDeCompras, { ...linhaDeCompras, limite: "", saldo_disponivel: "  " }]);
    expect(p).toEqual({ limite: false, saldo: false, utilizado: false, status: false });
    expect(ignoredFields(p)).toEqual(["limite", "saldo disponível", "valor utilizado", "status e autorização de comunicação"]);
  });
  it("basta uma célula preenchida; 'R$ -' é zero explícito", () => {
    expect(detectPresence([{ ...linhaDeCompras }, { ...linhaDeCompras, limite: "R$ -" }]).limite).toBe(true);
    expect(detectPresence([{ ...linhaDeCompras, status_cartao: "ATIVOU_CARTAO" }]).status).toBe(true);
    expect(detectPresence([{ ...linhaDeCompras, bloqueado: true }]).status).toBe(true);
    expect(ignoredFields({ limite: true, saldo: true, utilizado: false, status: true })).toEqual([]);
  });
});

describe("planUpdate — o incidente das compras importadas como cartões", () => {
  const prepared = (row: CardAccountRow) => {
    // prepareRow não é exportado: usa o caminho público (preview) para obter o mesmo PreparedRow indiretamente
    return row;
  };
  void prepared;

  async function planejar(row: CardAccountRow, existing: any, presence = detectPresence([row])) {
    const salt = "salt";
    const { hashDocument } = await import("./masking");
    existing.cpfHash = hashDocument(row.documento!, salt);
    const prisma: any = {
      tenant: { findUniqueOrThrow: jest.fn(async () => ({ cpfSalt: salt })) },
      client: { findMany: jest.fn(async () => [existing]) },
    };
    return { prisma, presence };
  }

  it("não zera limite, saldo, status nem autorização de quem já está na base", async () => {
    const ex = cliente();
    const { prisma, presence } = await planejar(linhaDeCompras, ex);
    const p = await previewCardAccountImport(prisma, "t1", [linhaDeCompras], presence);
    expect(p.atualizados).toBe(1);
    expect(p.limite.zerados).toBe(0);
    expect(p.limite.alterados).toBe(0);
    expect(p.saldoAlterados).toBe(0);
    expect(p.status.alterados).toBe(0);
    expect(p.autorizacao.revogadas).toBe(0);
    expect(p.cadastroAlterados).toBe(1); // só o nome mudou (Maria -> Maria Silva)
    expect(p.semAlteracao).toBe(0);
    expect(p.ignorados).toContain("limite");
  });

  it("o MESMO arquivo tratado como se trouxesse tudo (comportamento antigo) zeraria o limite", async () => {
    const ex = cliente();
    const { prisma } = await planejar(linhaDeCompras, ex);
    const p = await previewCardAccountImport(prisma, "t1", [linhaDeCompras], ALL_PRESENT);
    expect(p.limite.zerados).toBe(1);
    expect(p.exemplosZerados).toEqual([{ nome: "Maria", limiteAntes: 1500 }]);
    expect(p.status.paraInativo).toBe(1);
  });

  it("arquivo legítimo com limite e saldo atualiza só o que traz", async () => {
    const row: CardAccountRow = { ...linhaDeCompras, limite: "2.000,00", saldo_disponivel: "900,00" };
    const ex = cliente();
    const { prisma, presence } = await planejar(row, ex);
    expect(presence).toEqual({ limite: true, saldo: true, utilizado: false, status: false });
    const p = await previewCardAccountImport(prisma, "t1", [row], presence);
    expect(p.limite).toMatchObject({ alterados: 1, aumentaram: 1, zerados: 0 });
    expect(p.saldoAlterados).toBe(1);
    expect(p.status.alterados).toBe(0); // arquivo sem status não mexe no status
  });

  it("célula vazia numa coluna que existe continua sendo zero (comércio credenciado)", async () => {
    const comercio: CardAccountRow = { ...linhaDeCompras, documento: CPF_B, limite: "", saldo_disponivel: "" };
    const comLimite: CardAccountRow = { ...linhaDeCompras, limite: "1.000,00", saldo_disponivel: "100,00" };
    const ex = cliente();
    const { prisma } = await planejar(comercio, ex);
    const p = await previewCardAccountImport(prisma, "t1", [comercio, comLimite], detectPresence([comercio, comLimite]));
    expect(p.limite.zerados).toBe(1);
  });
});

describe("snapshotBefore / summarizeChange", () => {
  it("guarda só as colunas que a importação grava, prontas para ir ao banco como JSON", () => {
    const ex = cliente({ dataCadastro: new Date("2026-01-02T00:00:00Z"), limiteTotal: "1500.00" });
    const before = snapshotBefore(ex, { limiteTotal: 0, dataCadastro: new Date(), nome: "X", colunaInexistente: 1 } as any);
    expect(before).toEqual({ limiteTotal: "1500.00", dataCadastro: "2026-01-02T00:00:00.000Z", nome: "Maria" });
  });
  it("resume o que muda", () => {
    const ex = cliente();
    const s = summarizeChange(ex, planUpdate({ rowNumber: 2, cpfHash: "h", limiteTotal: 0, saldoDisponivel: 0, valorUtilizado: 0, statusConta: "INATIVO", data: { nome: "Maria", telefone: "+5584999998888", autorizacaoComunicacao: false } as any }, ex, ALL_PRESENT));
    expect(s).toMatchObject({ limiteZerado: true, statusAlterado: true, statusPara: "INATIVO", autorizacaoRevogada: true, saldoAlterado: true });
  });
});

describe("runCardAccountImport — grava só o que traz e guarda o estado anterior", () => {
  it("compras importadas como cartões: nada é zerado e o lote pode ser desfeito", async () => {
    const { hashDocument } = await import("./masking");
    const salt = "salt";
    const ex = cliente({ cpfHash: hashDocument(CPF_A, salt) });
    const upserts: any[] = [];
    const changes: any[] = [];
    const jobs: any[] = [];
    const prisma: any = {
      tenant: { findUniqueOrThrow: jest.fn(async () => ({ cpfSalt: salt })) },
      importJob: { create: jest.fn(async ({ data }: any) => { jobs.push(data); return { id: "job1" }; }), update: jest.fn(async () => ({})) },
      importChange: { deleteMany: jest.fn(async () => ({})), createMany: jest.fn(async ({ data }: any) => void changes.push(...data)) },
      client: { findMany: jest.fn(async () => [ex]), upsert: jest.fn(async (a: any) => { upserts.push(a); return { id: "c1" }; }) },
      movement: { createMany: jest.fn(async () => ({})) },
      accountSnapshot: { findMany: jest.fn(async () => []), createMany: jest.fn(async () => ({ count: 0 })) },
      notification: { create: jest.fn() },
    };
    const r = await runCardAccountImport(prisma, "t1", [linhaDeCompras], "u1", { loteId: "lote-1", nomeArquivo: "compras.csv" });
    expect(r.result.updatedCount).toBe(1);
    const update = upserts[0].update;
    for (const campo of ["limiteTotal", "saldoDisponivel", "valorUtilizado", "valorAntecipado", "percentualUtilizado", "faixaUso", "statusConta", "autorizacaoComunicacao"]) {
      expect(update).not.toHaveProperty(campo);
    }
    expect(update.nome).toBe("Maria Silva");
    expect(jobs[0]).toMatchObject({ formato: "cartoes", loteId: "lote-1", nomeArquivo: "compras.csv" });
    expect(changes).toEqual([expect.objectContaining({ clientId: "c1", kind: "ATUALIZADO", loteId: "lote-1", importJobId: "job1" })]);
    expect(changes[0].before).toMatchObject({ nome: "Maria" });
    expect(changes[0].before).not.toHaveProperty("limiteTotal");
  });

  it("cliente novo é criado completo e registrado como CRIADO", async () => {
    const changes: any[] = [];
    const prisma: any = {
      tenant: { findUniqueOrThrow: jest.fn(async () => ({ cpfSalt: "salt" })) },
      importJob: { create: jest.fn(async () => ({ id: "job2" })), update: jest.fn(async () => ({})) },
      importChange: { deleteMany: jest.fn(async () => ({})), createMany: jest.fn(async ({ data }: any) => void changes.push(...data)) },
      client: { findMany: jest.fn(async () => []), upsert: jest.fn(async () => ({ id: "novo1" })) },
      movement: { createMany: jest.fn(async () => ({})) },
      accountSnapshot: { findMany: jest.fn(async () => []), createMany: jest.fn(async () => ({ count: 1 })) },
      notification: { create: jest.fn() },
    };
    const r = await runCardAccountImport(prisma, "t1", [{ ...linhaDeCompras, limite: "1.000,00" }], "u1");
    expect(r.result.addedCount).toBe(1);
    expect(prisma.client.upsert.mock.calls[0][0].create.limiteTotal).toBe(1000);
    expect(changes).toEqual([expect.objectContaining({ clientId: "novo1", kind: "CRIADO" })]);
  });
});

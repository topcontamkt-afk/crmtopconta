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
  // LGPD 01-02: chave com valor undefined (coluna ausente) não leva o cadastro inteiro para o ImportChange
  it("não copia colunas que o arquivo não traz (valor undefined), como renda e nascimento", () => {
    const ex = cliente({ remuneracaoBruta: "9000.00", dataNascimento: new Date("1980-01-01"), sexo: "F" });
    const before = snapshotBefore(ex, { nome: "X", remuneracaoBruta: undefined, dataNascimento: undefined, sexo: undefined } as any);
    expect(before).toEqual({ nome: "Maria" });
  });
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
      tenant: { findUniqueOrThrow: jest.fn(async () => ({ cpfSalt: salt })), findUnique: jest.fn(async () => ({ cpfSalt: salt })) },
      supressaoTitular: { findMany: jest.fn(async () => []) }, campaignRecipient: { findMany: jest.fn(async () => []) },
      importJob: { create: jest.fn(async ({ data }: any) => { jobs.push(data); return { id: "job1" }; }), update: jest.fn(async () => ({})) },
      importChange: { deleteMany: jest.fn(async () => ({})), createMany: jest.fn(async ({ data }: any) => void changes.push(...data)) },
      client: { findMany: jest.fn(async ({ where }: any) => (where.optOutAt ? [] : [ex])), upsert: jest.fn(async (a: any) => { upserts.push(a); return { id: "c1" }; }) },
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
      tenant: { findUniqueOrThrow: jest.fn(async () => ({ cpfSalt: "salt" })), findUnique: jest.fn(async () => ({ cpfSalt: "salt" })) },
      supressaoTitular: { findMany: jest.fn(async () => []) }, campaignRecipient: { findMany: jest.fn(async () => []) },
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

/* ───────────── LGPD: supressão, bloqueio, correção manual, encerramento e minimização ───────────── */
import { hashDocument } from "./masking";
import { phoneHash } from "./privacy";

jest.mock("../middleware/audit", () => ({ logAudit: jest.fn(async () => undefined) }));
import { logAudit } from "../middleware/audit";

const SALT = "salt";
const HASH_A = hashDocument(CPF_A, SALT);

function fakeCartoes(opts: { existentes?: any[]; supressoes?: any[]; tenant?: any; optOutTelefones?: string[] } = {}) {
  const upserts: any[] = [];
  const changes: any[] = [];
  const supressoes = [...(opts.supressoes ?? [])];
  const prisma: any = {
    tenant: {
      findUniqueOrThrow: jest.fn(async () => ({ cpfSalt: SALT, correcaoManualVence: true, ...opts.tenant })),
      findUnique: jest.fn(async () => ({ cpfSalt: SALT })),
    },
    supressaoTitular: {
      findMany: jest.fn(async ({ where }: any) =>
        supressoes.filter(
          (r) =>
            r.tenantId === where.tenantId &&
            ((where.docHash?.in ?? []).includes(r.docHash) || (where.OR ?? []).some((o: any) => (o.phoneHash && o.phoneHash === r.phoneHash) || (o.docHash && o.docHash === r.docHash)))
        )
      ),
      deleteMany: jest.fn(async ({ where }: any) => {
        const antes = supressoes.length;
        for (let i = supressoes.length - 1; i >= 0; i--) if (supressoes[i].docHash === where.docHash && supressoes[i].motivo === where.motivo) supressoes.splice(i, 1);
        return { count: antes - supressoes.length };
      }),
    },
    campaignRecipient: { findMany: jest.fn(async () => []) },
    importJob: { create: jest.fn(async () => ({ id: "job1" })), update: jest.fn(async () => ({})) },
    importChange: { createMany: jest.fn(async ({ data }: any) => void changes.push(...data)) },
    client: {
      findMany: jest.fn(async ({ where }: any) => {
        if (where.optOutAt) return (opts.optOutTelefones ?? []).filter((t) => where.telefone.in.includes(t)).map((telefone) => ({ telefone }));
        return (opts.existentes ?? []).filter((c) => where.cpfHash.in.includes(c.cpfHash));
      }),
      upsert: jest.fn(async (a: any) => {
        upserts.push(a);
        return { id: opts.existentes?.[0]?.id ?? "novo" };
      }),
    },
    movement: { createMany: jest.fn(async () => ({})) },
    accountSnapshot: { findMany: jest.fn(async () => []), createMany: jest.fn(async () => ({ count: 0 })) },
    notification: { create: jest.fn() },
  };
  return { prisma, upserts, changes, supressoes };
}

const eliminacao = (over: any = {}) => ({ id: "s1", tenantId: "t1", phoneHash: phoneHash(SALT, "+5584999998888"), docHash: HASH_A, motivo: "ELIMINACAO", createdAt: new Date("2026-10-01T00:00:00Z"), ...over });

describe("LGPD 03-01: eliminação resiste à reimportação (só pelo documento)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("reimportar a mesma linha antiga do titular eliminado: ignorada, contada, sem PII no resultado", async () => {
    const { prisma, upserts } = fakeCartoes({ supressoes: [eliminacao()] });
    const r = await runCardAccountImport(prisma, "t1", [{ ...linhaDeCompras, data_ativacao: "2024-05-10" }], "u1");
    expect(upserts).toHaveLength(0);
    expect(r.result).toMatchObject({ addedCount: 0, eliminadosAPedido: 1 });
    expect(JSON.stringify(r.result)).not.toMatch(/Maria|99999|529/);
  });

  it("sem a supressão (comportamento antigo), a mesma linha recriava o titular", async () => {
    const { prisma, upserts } = fakeCartoes();
    await runCardAccountImport(prisma, "t1", [{ ...linhaDeCompras, data_ativacao: "2024-05-10" }], "u1");
    expect(upserts).toHaveLength(1);
  });

  it("abertura de conta POSTERIOR ao pedido: volta como cliente novo, libera a supressão e audita sem PII", async () => {
    const { prisma, upserts, supressoes } = fakeCartoes({ supressoes: [eliminacao()] });
    const r = await runCardAccountImport(prisma, "t1", [{ ...linhaDeCompras, data_ativacao: "2026-10-15", status_cartao: "ATIVOU_CARTAO" }], "u1");
    expect(upserts).toHaveLength(1);
    expect(r.result).toMatchObject({ addedCount: 1, supressoesLiberadas: 1, eliminadosAPedido: 0 });
    expect(supressoes).toHaveLength(0);
    const audit = (logAudit as jest.Mock).mock.calls.map((c) => c[0]).find((a) => a.action === "SUPRESSAO_LIBERADA");
    expect(audit.details).toMatchObject({ motivo: "NOVA_RELACAO" });
    expect(JSON.stringify(audit)).not.toContain(HASH_A);
  });

  it("telefone suprimido por ELIMINACAO com CPF diferente (número reaproveitado) entra normalmente", async () => {
    const { prisma, upserts } = fakeCartoes({ supressoes: [eliminacao({ docHash: "doc-de-outra-pessoa" })] });
    const r = await runCardAccountImport(prisma, "t1", [{ ...linhaDeCompras, status_cartao: "ATIVOU_CARTAO" }], "u1");
    expect(r.result).toMatchObject({ addedCount: 1, eliminadosAPedido: 0 });
    expect(upserts[0].create.autorizacaoComunicacao).toBe(true);
  });

  it("OPT_OUT pelo telefone: a linha entra, mas sem autorização e com opt-out (novo e existente)", async () => {
    const optOut = { id: "s9", tenantId: "t1", phoneHash: phoneHash(SALT, "+5584999998888"), docHash: null, motivo: "OPT_OUT", createdAt: new Date() };
    const novo = fakeCartoes({ supressoes: [optOut] });
    await runCardAccountImport(novo.prisma, "t1", [{ ...linhaDeCompras, status_cartao: "ATIVOU_CARTAO" }], "u1");
    expect(novo.upserts[0].create).toMatchObject({ autorizacaoComunicacao: false, optOutAt: expect.any(Date) });

    const ex = cliente({ cpfHash: HASH_A, autorizacaoComunicacao: false });
    const existente = fakeCartoes({ existentes: [ex], optOutTelefones: ["+5584999998888"] }); // opt-out legado em outro cadastro
    await runCardAccountImport(existente.prisma, "t1", [{ ...linhaDeCompras, status_cartao: "ATIVOU_CARTAO" }], "u1");
    expect(existente.upserts[0].update).toMatchObject({ autorizacaoComunicacao: false, optOutAt: expect.any(Date) });
  });
});

describe("LGPD 03-04 / 03-03: bloqueio e correção manual na importação", () => {
  it("cliente com tratamento bloqueado não é atualizado (ignorado com aviso)", async () => {
    const { prisma, upserts } = fakeCartoes({ existentes: [cliente({ cpfHash: HASH_A, bloqueadoLgpdAt: new Date() })] });
    const r = await runCardAccountImport(prisma, "t1", [linhaDeCompras], "u1");
    expect(upserts).toHaveLength(0);
    expect(r.result).toMatchObject({ updatedCount: 0, bloqueadosLgpd: 1 });
  });

  it("campo corrigido à mão não é sobrescrito e o resultado conta a divergência", async () => {
    const ex = cliente({ cpfHash: HASH_A, nome: "Maria Corrigida", camposCorrigidos: { nome: "2026-10-10T00:00:00.000Z" } });
    const { prisma, upserts } = fakeCartoes({ existentes: [ex] });
    const r = await runCardAccountImport(prisma, "t1", [linhaDeCompras], "u1");
    expect(upserts[0].update).not.toHaveProperty("nome");
    expect(r.result).toMatchObject({ camposPreservadosCorrecao: 1, clientesComCorrecaoPreservada: 1 });
  });

  it("com correcaoManualVence=false a planilha volta a valer", async () => {
    const ex = cliente({ cpfHash: HASH_A, nome: "Maria Corrigida", camposCorrigidos: { nome: "2026-10-10T00:00:00.000Z" } });
    const { prisma, upserts } = fakeCartoes({ existentes: [ex], tenant: { correcaoManualVence: false } });
    await runCardAccountImport(prisma, "t1", [linhaDeCompras], "u1");
    expect(upserts[0].update.nome).toBe("Maria Silva");
  });
});

describe("LGPD 04-06 / 01-01: encerramento e minimização", () => {
  it("encerradoEm guarda a primeira data e conta encerrada perde a autorização", async () => {
    const primeira = new Date("2026-01-05T00:00:00Z");
    const ex = cliente({ cpfHash: HASH_A, encerradoEm: primeira });
    const { prisma, upserts } = fakeCartoes({ existentes: [ex] });
    await runCardAccountImport(prisma, "t1", [{ ...linhaDeCompras, encerrado: "sim" }], "u1");
    expect(upserts[0].update).not.toHaveProperty("encerradoEm");
    expect(upserts[0].update.autorizacaoComunicacao).toBe(false);
    expect(upserts[0].create.encerradoEm).toBeInstanceOf(Date); // cliente novo: data de hoje
  });

  it("data de ativação antiga não faz regredir o último uso conhecido", () => {
    const ex = cliente({ dataUltimaUtilizacao: new Date("2026-10-01T00:00:00Z") });
    const p = { rowNumber: 2, cpfHash: "h", limiteTotal: 0, saldoDisponivel: 0, valorUtilizado: 0, statusConta: "ATIVO" as const, data: { nome: "Maria", dataUltimaUtilizacao: new Date("2020-01-01") } as any };
    expect(planUpdate(p, ex, ALL_PRESENT).update).not.toHaveProperty("dataUltimaUtilizacao");
  });

  it("e-mail, lotação, bônus, saldo para saque, vínculo, cidade da conveniada, motivo/obs de encerramento, razão social e status de validação não são gravados", async () => {
    const { prisma, upserts } = fakeCartoes();
    const linha: any = {
      ...linhaDeCompras, email: "m@x.com", lotacao: "SEMED", bonus: "100", saldo_liquido_saque: "50", vinculo_empregaticio: "EFETIVO",
      cidade_empresa_conveniada: "Natal", motivo_encerramento: "x", obs_encerramento: "y", razao_social: "Assoc", status_cadastro: "APROVADO",
    };
    await runCardAccountImport(prisma, "t1", [linha], "u1");
    const create = upserts[0].create;
    for (const campo of ["email", "lotacao", "bonus", "saldoLiquidoSaque", "vinculoEmpregaticio", "cidadeEmpresaConveniada", "motivoEncerramento", "obsEncerramento", "razaoSocial", "statusValidacaoCadastro"]) {
      expect(create[campo]).toBeUndefined();
    }
    expect(create.statusConta).toBe("INATIVO"); // status_cadastro continua sendo lido para inferir o status
  });
});

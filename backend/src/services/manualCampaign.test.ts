import { matchManualAudience, parseManualRows } from "./manualCampaign";
import { phoneHash } from "./privacy";
import { recipientContext, renderTemplate, templateContext, usesLimiteDisponivel } from "./messageContext";
import { TEMPLATE_VARIABLES } from "./templateVariables";

const SALT = "salt-teste";

describe("parseManualRows", () => {
  it("normaliza telefone, CPF (com zero perdido) e limite no formato BR", () => {
    const { valid, rejected } = parseManualRows(
      [{ nome: " Maria ", telefone: "(84) 99999-8888", cpf: "1234567891", limiteDisponivel: "R$ 1.250,50" }],
      SALT
    );
    // CPF com dígito verificador errado é recusado
    expect(valid).toHaveLength(0);
    expect(rejected[0].motivo).toMatch(/CPF/);

    const ok = parseManualRows([{ nome: " Maria ", telefone: "(84) 99999-8888", cpf: "529.982.247-25", limiteDisponivel: "R$ 1.250,50" }], SALT);
    expect(ok.valid[0]).toMatchObject({ nome: "Maria", telefone: "+5584999998888", limiteDisponivel: 1250.5, cpfMasked: expect.any(String) });
    expect(ok.valid[0].cpfHash).toHaveLength(64);
  });

  it("recompõe o zero à esquerda perdido pela planilha", () => {
    // 01234567890 é um CPF válido; a planilha entregou 1234567890 (10 dígitos)
    const { valid } = parseManualRows([{ nome: "A", telefone: "84999998888", cpf: 1234567890 }], SALT);
    expect(valid).toHaveLength(1);
    expect(valid[0].cpfMasked).toBe("***.345.***-90");
  });

  it("CPF é opcional e o mesmo CPF gera o mesmo hash", () => {
    const { valid } = parseManualRows(
      [
        { nome: "A", telefone: "84999998888" },
        { nome: "B", telefone: "84988887777", cpf: "52998224725" },
        { nome: "C", telefone: "84977776666", cpf: "529.982.247-25" },
      ],
      SALT
    );
    expect(valid[0].cpfHash).toBeNull();
    expect(valid[1].cpfHash).toBe(valid[2].cpfHash);
  });

  it("recusa sem nome, telefone inválido, repetido e limite inválido", () => {
    const { valid, rejected } = parseManualRows(
      [
        { nome: "", telefone: "84999998888" },
        { nome: "X", telefone: "123" },
        { nome: "Y", telefone: "84999998888", limiteDisponivel: "abc" },
        { nome: "Z", telefone: "84999998888" },
        { nome: "W", telefone: "84999998888" },
      ],
      SALT
    );
    expect(valid.map((v) => v.nome)).toEqual(["Z"]);
    expect(rejected.map((r) => r.motivo)).toEqual(["Sem nome", "Telefone inválido", "Limite disponível inválido", "Telefone repetido na lista"]);
    expect(rejected.map((r) => r.linha)).toEqual([1, 2, 3, 5]);
  });
});

describe("limite disponível na mensagem", () => {
  it("é variável aceita e tem o mesmo valor de {{saldo}} na campanha tradicional", () => {
    expect(TEMPLATE_VARIABLES).toContain("limite_disponivel");
    const ctx = templateContext({ nome: "Ana", cidade: "Natal", percentualUtilizado: 40, saldoDisponivel: 850, limiteTotal: 2000 });
    expect(ctx.limite_disponivel).toBe(ctx.saldo);
    expect(renderTemplate("Você tem {{limite_disponivel}} livres", ctx)).toMatch(/850,00/);
  });

  it("na lista manual vem da planilha e nunca do saldo do cliente", () => {
    const ctx = recipientContext({ nome: "Ana", limiteDisponivel: 300 }, { cidade: "Natal", percentualUtilizado: 40, limiteTotal: 2000 });
    expect(String(ctx.limite_disponivel)).toMatch(/300,00/);
    expect(ctx.saldo).toBe(ctx.limite_disponivel);
    expect(String(ctx.limite)).toMatch(/2\.000,00/);
  });

  it("sem limite na planilha fica vazio e o texto é detectado", () => {
    const ctx = recipientContext({ nome: "Ana", limiteDisponivel: null }, null);
    expect(ctx.limite_disponivel).toBe("");
    expect(usesLimiteDisponivel("Olá {{nome}}, você tem {{limite_disponivel}}")).toBe(true);
    expect(usesLimiteDisponivel("Olá {{ saldo }}")).toBe(true);
    expect(usesLimiteDisponivel("Olá {{nome}}, limite total {{limite}}")).toBe(false);
  });
});

// LGPD 02-03: a lista nova não pode trazer de volta quem pediu para parar por OUTRO registro com o mesmo número
describe("matchManualAudience — supressão por telefone", () => {
  const SALT_T = "salt-t1";
  const row = (telefone: string, cpfHash: string | null = null, linha = 1) => ({ linha, nome: "X", telefone, cpfHash, cpfMasked: null, limiteDisponivel: 100 });
  function fake(opts: { clientes?: any[]; supressoes?: any[]; optOutClientes?: string[] } = {}) {
    return {
      client: {
        findMany: jest.fn(async ({ where }: any) => {
          if (where.optOutAt) return (opts.optOutClientes ?? []).filter((t) => where.telefone.in.includes(t)).map((telefone) => ({ telefone }));
          if (where.cpfHash) return (opts.clientes ?? []).filter((c) => where.cpfHash.in.includes(c.cpfHash));
          return (opts.clientes ?? []).filter((c) => where.telefone.in.includes(c.telefone));
        }),
      },
      campaignRecipient: { findMany: jest.fn(async () => []) },
      tenant: { findUnique: jest.fn(async () => ({ cpfSalt: SALT_T })) },
      supressaoTitular: { findMany: jest.fn(async () => opts.supressoes ?? []) },
    } as any;
  }
  const cliente = (over: any = {}) => ({ id: "c1", cpfHash: "doc1", telefone: "+5584999998888", autorizacaoComunicacao: true, optOutAt: null, bloqueadoLgpdAt: null, statusConta: "ATIVO", limiteTotal: 1000, ...over });

  it("telefone suprimido (contato fora da base) é excluído", async () => {
    const prisma = fake({ supressoes: [{ tenantId: "t1", phoneHash: phoneHash(SALT_T, "+5584977776666"), docHash: null, motivo: "OPT_OUT" }] });
    const [r] = await matchManualAudience(prisma, "t1", [row("+558477776666")]);
    expect(r.excluidoMotivo).toMatch(/opt-out/);
  });

  it("casado por CPF a um cliente liberado, mas o número tem opt-out em outro cadastro: excluído", async () => {
    const prisma = fake({ clientes: [cliente({ telefone: "+5584911110000" })], optOutClientes: ["+5584999998888"] });
    const [r] = await matchManualAudience(prisma, "t1", [row("+5584999998888", "doc1")]);
    expect(r.clientId).toBe("c1");
    expect(r.excluidoMotivo).toMatch(/opt-out/);
  });

  it("cliente com tratamento bloqueado a pedido do titular é excluído", async () => {
    const prisma = fake({ clientes: [cliente({ bloqueadoLgpdAt: new Date() })] });
    const [r] = await matchManualAudience(prisma, "t1", [row("+5584999998888", "doc1")]);
    expect(r.excluidoMotivo).toMatch(/bloqueado/);
  });

  it("contato liberado passa", async () => {
    const prisma = fake({ clientes: [cliente()] });
    const [r] = await matchManualAudience(prisma, "t1", [row("+5584999998888", "doc1")]);
    expect(r.excluidoMotivo).toBeNull();
  });
});

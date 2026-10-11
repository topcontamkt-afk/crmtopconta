import { parseManualRows } from "./manualCampaign";
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

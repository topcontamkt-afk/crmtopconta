import { classifyTransaction, normalizeDescricao } from "./transactionClassifier";

describe("classifyTransaction", () => {
  it("Débito Pix Cartão é antecipação e conta como uso", () => {
    expect(classifyTransaction("Débito Pix Cartão")).toEqual({ kind: "ANTECIPACAO", countsAsUsage: true });
  });

  it("Compra à Vista Cartão Top Convênio é compra e conta como uso", () => {
    expect(classifyTransaction("Compra à Vista Cartão Top Convênio")).toEqual({ kind: "COMPRA", countsAsUsage: true });
  });

  it("assinatura NÃO conta como uso (cobrança automática, sem decisão do cliente)", () => {
    expect(classifyTransaction("Assinatura AMEF-Gleebem")).toEqual({ kind: "ASSINATURA", countsAsUsage: false });
    expect(classifyTransaction("Assinatura ASSOCIACAO MUN ESP DOS FUNCION")).toEqual({
      kind: "ASSINATURA",
      countsAsUsage: false,
    });
  });

  it("descrição desconhecida vira OUTRO e não conta como uso (nunca infla conversão)", () => {
    expect(classifyTransaction("Pagamento de Fatura")).toEqual({ kind: "OUTRO", countsAsUsage: false });
    expect(classifyTransaction("")).toEqual({ kind: "OUTRO", countsAsUsage: false });
  });

  it("débito de fatura e saque avulso não contam como uso (só a antecipação via Pix)", () => {
    expect(classifyTransaction("Débito de Fatura").countsAsUsage).toBe(false);
    expect(classifyTransaction("Saque").countsAsUsage).toBe(false);
  });

  it("ignora acento, caixa e espaços repetidos", () => {
    expect(classifyTransaction("  DEBITO   PIX  CARTAO ").kind).toBe("ANTECIPACAO");
    expect(classifyTransaction("compra a vista cartao top convenio").kind).toBe("COMPRA");
    expect(normalizeDescricao("Débito  Pix")).toBe("debito pix");
  });
});

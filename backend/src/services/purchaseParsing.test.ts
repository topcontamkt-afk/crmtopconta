import { isCommercePurchase, isUsageType, normalizeDocumentDigits, parseMoney, parsePurchaseDate } from "./purchaseParsing";

describe("parseMoney", () => {
  it.each([
    ["R$ 446.20 ", 446.2],
    ["R$ 1,591.00", 1591],
    ["R$ 500,00", 500],
    ["R$ 1.234,56", 1234.56],
    ["R$ 8,470.00", 8470],
    ["R$ -", 0],
    ["", 0],
    ["R$ 0.00", 0],
    ["1.500", 1500],
    ["1,500", 1500],
    ["12.5", 12.5],
    ["R$ 1.234.567,89", 1234567.89],
    [388, 388],
  ])("%p => %p", (entrada, esperado) => {
    expect(parseMoney(entrada)).toBe(esperado);
  });

  it("devolve null para lixo e trata negativo", () => {
    expect(parseMoney("abc")).toBeNull();
    expect(parseMoney("R$ -12.50")).toBe(-12.5);
    expect(parseMoney(undefined)).toBeNull();
  });
});

describe("parsePurchaseDate", () => {
  it("lê dd/mm/aaaa hh:mm:ss em horário de Brasília", () => {
    expect(parsePurchaseDate("15/06/2026 11:41:05")!.toISOString()).toBe("2026-06-15T14:41:05.000Z");
  });
  it("aceita só a data e ISO; rejeita lixo", () => {
    expect(parsePurchaseDate("15/06/2026")!.toISOString()).toBe("2026-06-15T03:00:00.000Z");
    expect(parsePurchaseDate("2026-06-15T10:00:00Z")!.toISOString()).toBe("2026-06-15T10:00:00.000Z");
    expect(parsePurchaseDate("31/02/abc")).toBeNull();
    expect(parsePurchaseDate("31/02/2026")).toBeNull();
    expect(parsePurchaseDate("")).toBeNull();
  });
});

describe("normalizeDocumentDigits", () => {
  it("recompõe zero à esquerda perdido pela planilha", () => {
    expect(normalizeDocumentDigits("6124745615")).toBe("06124745615");
    expect(normalizeDocumentDigits("123.456.789-09")).toBe("12345678909");
    expect(normalizeDocumentDigits("1234567000199")).toBe("01234567000199");
  });
  it("rejeita vazio e tamanho impossível", () => {
    expect(normalizeDocumentDigits("")).toBeNull();
    expect(normalizeDocumentDigits("123456789012345")).toBeNull();
  });
});

describe("tipos de transação", () => {
  it("compra no comércio é só 'Compra à Vista...'", () => {
    expect(isCommercePurchase("Compra à Vista Cartão Top Convênio")).toBe(true);
    expect(isCommercePurchase("Débito Saque Cartão")).toBe(false);
    expect(isCommercePurchase("Assinatura AMEF-Gleebem")).toBe(false);
  });
  it("utilização = compra, saque ou Pix; assinatura e fatura não", () => {
    expect(isUsageType("Débito Saque Cartão")).toBe(true);
    expect(isUsageType("Débito Pix Cartão")).toBe(true);
    expect(isUsageType("Compra à Vista Cartão Top Convênio")).toBe(true);
    expect(isUsageType("Assinatura TopConta-Gleebem")).toBe(false);
    expect(isUsageType("Débito da Fatura Anterior")).toBe(false);
  });
});

import { classifyTransaction, normalizeDescricao, parseBrDateTime, parseMoney } from "./transactionClassifier";

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

  it("ignora acento, caixa e espaços repetidos", () => {
    expect(classifyTransaction("  DEBITO   PIX  CARTAO ").kind).toBe("ANTECIPACAO");
    expect(classifyTransaction("compra a vista cartao top convenio").kind).toBe("COMPRA");
    expect(normalizeDescricao("Débito  Pix")).toBe("debito pix");
  });
});

describe("parseBrDateTime", () => {
  it("lê dd/mm/aaaa hh:mm:ss como dia-primeiro, horário de Brasília convertido para UTC", () => {
    expect(parseBrDateTime("15/09/2026 15:13:55")?.toISOString()).toBe("2026-09-15T18:13:55.000Z");
  });

  it("10/9/2026 é 10 de setembro, não 9 de outubro (new Date() leria ao contrário)", () => {
    expect(parseBrDateTime("10/9/2026 01:33:27")?.toISOString()).toBe("2026-09-10T04:33:27.000Z");
  });

  it("uma transação às 22h de Brasília cai no dia seguinte em UTC, mas não no dia local", () => {
    expect(parseBrDateTime("09/10/2026 22:30:00")?.toISOString()).toBe("2026-10-10T01:30:00.000Z");
  });

  it("aceita só a data (meia-noite de Brasília) e hora sem segundos", () => {
    expect(parseBrDateTime("09/10/2026")?.toISOString()).toBe("2026-10-09T03:00:00.000Z");
    expect(parseBrDateTime("09/10/2026 14:05")?.toISOString()).toBe("2026-10-09T17:05:00.000Z");
  });

  it("aceita ISO sem fuso como Brasília e ISO com fuso explícito", () => {
    expect(parseBrDateTime("2026-09-15 15:13:55")?.toISOString()).toBe("2026-09-15T18:13:55.000Z");
    expect(parseBrDateTime("2026-09-15T18:13:55Z")?.toISOString()).toBe("2026-09-15T18:13:55.000Z");
  });

  it("rejeita datas impossíveis e formatos desconhecidos", () => {
    expect(parseBrDateTime("31/02/2026 10:00:00")).toBeNull();
    expect(parseBrDateTime("15/13/2026")).toBeNull();
    expect(parseBrDateTime("15/09/2026 25:00:00")).toBeNull();
    expect(parseBrDateTime("ontem")).toBeNull();
    expect(parseBrDateTime("")).toBeNull();
    expect(parseBrDateTime(undefined)).toBeNull();
  });
});

describe("parseMoney", () => {
  it("lê vírgula decimal, com e sem milhar", () => {
    expect(parseMoney("356,5")).toBe(356.5);
    expect(parseMoney("1920,5")).toBe(1920.5);
    expect(parseMoney("1.920,50")).toBe(1920.5);
    expect(parseMoney("R$ 29,90")).toBe(29.9);
  });

  it("ponto sozinho: decimal quando não parece milhar, milhar quando parece", () => {
    expect(parseMoney("29.9")).toBe(29.9);
    expect(parseMoney("1.92")).toBe(1.92);
    expect(parseMoney("1.920")).toBe(1920);
    expect(parseMoney("1.234.567")).toBe(1234567);
  });

  it("inteiros e números nativos passam direto", () => {
    expect(parseMoney("1940")).toBe(1940);
    expect(parseMoney(310)).toBe(310);
  });

  it("vazio e '-' são zero (ex.: Juros em compra à vista)", () => {
    expect(parseMoney("")).toBe(0);
    expect(parseMoney("-")).toBe(0);
    expect(parseMoney("R$ -")).toBe(0);
  });

  it("negativo é preservado para a linha poder ser recusada", () => {
    expect(parseMoney("-45,00")).toBe(-45);
    expect(parseMoney("(45,00)")).toBe(-45);
  });

  it("devolve null para lixo, em vez de gravar um valor errado", () => {
    expect(parseMoney("abc")).toBeNull();
    expect(parseMoney("12,34,56")).toBeNull();
    expect(parseMoney("1,2.3")).toBeNull();
    expect(parseMoney(undefined)).toBeNull();
  });
});

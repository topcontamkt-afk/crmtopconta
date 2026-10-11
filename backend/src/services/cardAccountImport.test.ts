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

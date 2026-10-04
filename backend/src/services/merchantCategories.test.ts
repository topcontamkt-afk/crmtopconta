import { categorizeMerchant, isMerchantCategory, normalizeMerchantName } from "./merchantCategories";

// Nomes reais de lojistas da aba "Todas as Compras" (só nome fantasia do comércio, sem dado pessoal).
const CASOS: [string, string][] = [
  ["Valentina Supermercado", "SUPERMERCADO"],
  ["Posto Romeiros 4", "POSTO"],
  ["Posto Central", "POSTO"],
  ["Supermercado Santo Antonio", "SUPERMERCADO"],
  ["Supermercado Santo Antônio", "SUPERMERCADO"],
  ["Supersam Supermercados 07", "SUPERMERCADO"],
  ["Mercado Vizinhaca", "SUPERMERCADO"],
  ["Mercante Supermercado", "SUPERMERCADO"],
  ["Mercadão Hortifruti", "SUPERMERCADO"],
  ["Recife Mini Mercado Express", "SUPERMERCADO"],
  ["Supermercado E Panificação Pão Bom", "SUPERMERCADO"],
  ["Drogaria Do Povo Trabalhador", "FARMACIA"],
  ["Drogavan", "FARMACIA"],
  ["Drogaria São Miguel", "FARMACIA"],
  ["Natural Farma", "FARMACIA"],
  ["Açougue Do Paulinho", "ACOUGUE"],
  ["Casa Da Carne Santo Antonio", "ACOUGUE"],
  ["Carnes E Frios Melhor Preço", "ACOUGUE"],
  ["Casa Carne Itabaiana", "ACOUGUE"],
  ["Silvia da Galinha", "ACOUGUE"],
  ["Camarão e Pescados Do João", "ACOUGUE"],
  ["Papelaria E Aviamentos Raquel E Cia", "PAPELARIA"],
  ["Papelaria Futura", "PAPELARIA"],
  ["Ponto Alto - Materiais Para Construcao", "CONSTRUCAO"],
  ["Luzipecas", "AUTOPECAS"],
  ["Costa Academia", "ACADEMIA"],
  ["Naturalgas", "GAS_AGUA"],
  ["Moda - Mil", "VESTUARIO"],
  ["Loja Betel", "OUTROS"],
];

describe("categorizeMerchant", () => {
  it.each(CASOS)("%s => %s", (nome, categoria) => {
    expect(categorizeMerchant(nome)).toBe(categoria);
  });

  it("nome vazio ou desconhecido cai em OUTROS", () => {
    expect(categorizeMerchant("")).toBe("OUTROS");
    expect(categorizeMerchant("XYZ Comercio")).toBe("OUTROS");
  });

  it("posto tem prioridade sobre outras regras", () => {
    expect(categorizeMerchant("Auto Posto Silva")).toBe("POSTO");
  });
});

describe("normalizeMerchantName", () => {
  it("ignora acento, caixa e espaços repetidos", () => {
    expect(normalizeMerchantName("  Supermercado   Santo Antônio ")).toBe(normalizeMerchantName("supermercado santo antonio"));
  });
});

describe("isMerchantCategory", () => {
  it("valida contra a lista fixa", () => {
    expect(isMerchantCategory("POSTO")).toBe(true);
    expect(isMerchantCategory("posto")).toBe(false);
    expect(isMerchantCategory("QUALQUER")).toBe(false);
  });
});

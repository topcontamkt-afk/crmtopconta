import {
  detectDocumentType,
  hashCPF,
  isValidCNPJ,
  isValidCPF,
  isValidDocument,
  maskCPF,
  maskDocument,
  maskPhone,
  normalizePhone,
} from "./masking";

describe("isValidCPF", () => {
  it("aceita CPFs válidos", () => {
    expect(isValidCPF("529.982.247-25")).toBe(true);
  });

  it("rejeita CPFs com dígito verificador inválido", () => {
    expect(isValidCPF("529.982.247-26")).toBe(false);
  });

  it("rejeita CPFs com todos os dígitos iguais", () => {
    expect(isValidCPF("111.111.111-11")).toBe(false);
  });
});

describe("maskCPF", () => {
  it("mascara mantendo apenas os 3 dígitos centrais e os 2 finais", () => {
    expect(maskCPF("52998224725")).toBe("***.982.***-25");
  });
});

describe("hashCPF", () => {
  it("é determinístico para o mesmo salt e não reversível", () => {
    const h1 = hashCPF("52998224725", "salt-a");
    const h2 = hashCPF("52998224725", "salt-a");
    const h3 = hashCPF("52998224725", "salt-b");
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).not.toContain("52998224725");
  });
});

describe("isValidCNPJ", () => {
  it("aceita CNPJs válidos", () => {
    expect(isValidCNPJ("11.222.333/0001-81")).toBe(true);
  });

  it("rejeita CNPJs com dígito verificador inválido", () => {
    expect(isValidCNPJ("11.222.333/0001-80")).toBe(false);
  });

  it("rejeita CNPJs com todos os dígitos iguais", () => {
    expect(isValidCNPJ("11.111.111/1111-11")).toBe(false);
  });
});

describe("detectDocumentType / isValidDocument / maskDocument", () => {
  it("detecta CPF (11 dígitos) e CNPJ (14 dígitos)", () => {
    expect(detectDocumentType("529.982.247-25")).toBe("CPF");
    expect(detectDocumentType("11.222.333/0001-81")).toBe("CNPJ");
    expect(detectDocumentType("123")).toBeNull();
  });

  it("isValidDocument aceita CPF ou CNPJ válidos e rejeita o resto", () => {
    expect(isValidDocument("529.982.247-25")).toBe(true);
    expect(isValidDocument("11.222.333/0001-81")).toBe(true);
    expect(isValidDocument("11.222.333/0001-80")).toBe(false);
    expect(isValidDocument("123")).toBe(false);
  });

  it("maskDocument mascara CNPJ mantendo só alguns dígitos visíveis", () => {
    expect(maskDocument("11222333000181")).toBe("**.***.333/****-81");
  });
});

describe("normalizePhone", () => {
  it("normaliza para E.164 (BR)", () => {
    expect(normalizePhone("(11) 99999-8888")).toBe("+5511999998888");
  });

  it("retorna null para telefone inválido", () => {
    expect(normalizePhone("123")).toBeNull();
  });
});

describe("maskPhone", () => {
  it("mantém apenas os últimos 4 dígitos visíveis", () => {
    expect(maskPhone("+5511999998888")).toBe("*********8888");
  });
});

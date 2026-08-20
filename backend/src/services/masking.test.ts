import { hashCPF, isValidCPF, maskCPF, maskPhone, normalizePhone } from "./masking";

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

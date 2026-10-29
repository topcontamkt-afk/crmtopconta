import { isLocked, lockedMinutesRemaining } from "./authSecurity";

describe("isLocked", () => {
  it("retorna false quando lockedUntil é nulo", () => {
    expect(isLocked({ lockedUntil: null })).toBe(false);
  });

  it("retorna false quando lockedUntil já passou", () => {
    expect(isLocked({ lockedUntil: new Date(Date.now() - 1000) })).toBe(false);
  });

  it("retorna true quando lockedUntil está no futuro", () => {
    expect(isLocked({ lockedUntil: new Date(Date.now() + 60000) })).toBe(true);
  });
});

describe("lockedMinutesRemaining", () => {
  it("retorna 0 quando não há bloqueio", () => {
    expect(lockedMinutesRemaining({ lockedUntil: null })).toBe(0);
  });

  it("arredonda para cima os minutos restantes", () => {
    const result = lockedMinutesRemaining({ lockedUntil: new Date(Date.now() + 61000) });
    expect(result).toBe(2); // 61s arredonda pra 2min
  });
});

// LGPD 05-03
import { maskEmail, MAX_FAILED_ATTEMPTS, registerFailedLogin } from "./authSecurity";

describe("maskEmail (LGPD 05-03)", () => {
  it("mantém só as 2 primeiras letras e o domínio", () => {
    expect(maskEmail("joao.silva@Empresa.com")).toBe("jo***@empresa.com");
  });

  it("nunca devolve o endereço inteiro, nem com parte local curta", () => {
    expect(maskEmail("ab@x.com")).toBe("a***@x.com");
    expect(maskEmail("a@x.com")).toBe("***@x.com");
    expect(maskEmail("sem-arroba")).toBe("***");
  });
});

describe("registerFailedLogin (LGPD 05-03)", () => {
  const prismaFake = () => ({ user: { update: jest.fn(async () => ({})) } }) as any;

  it("devolve a contagem sem bloqueio abaixo do limite", async () => {
    const p = prismaFake();
    await expect(registerFailedLogin(p, "u1", 0)).resolves.toEqual({ count: 1, locked: false, lockedUntil: null });
  });

  it("no limite devolve locked e a data do bloqueio (para a rota auditar LOGIN_BLOQUEADO)", async () => {
    const p = prismaFake();
    const r = await registerFailedLogin(p, "u1", MAX_FAILED_ATTEMPTS - 1);
    expect(r.locked).toBe(true);
    expect(r.count).toBe(MAX_FAILED_ATTEMPTS);
    expect(r.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(p.user.update.mock.calls[0][0].data.lockedUntil).toEqual(r.lockedUntil);
  });
});

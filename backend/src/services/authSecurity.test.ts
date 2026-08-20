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

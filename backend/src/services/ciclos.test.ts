import { cicloInfo, diaFechamentoPadrao, diasAberturaNaFaixa, validDiaAbertura } from "./ciclos";

describe("cicloInfo", () => {
  it("no próprio dia de abertura: abriu hoje, dia 1 do ciclo, próxima em ~1 mês", () => {
    const i = cicloInfo(15, { y: 2026, m: 10, d: 15 });
    expect(i.diasDesdeAbertura).toBe(0);
    expect(i.diaDoCiclo).toBe(1);
    expect(i.proximaAbertura).toEqual({ y: 2026, m: 11, d: 15 });
    expect(i.diasParaAbrir).toBe(31);
  });

  it("antes da abertura do mês: última foi no mês anterior", () => {
    const i = cicloInfo(15, { y: 2026, m: 10, d: 12 });
    expect(i.ultimaAbertura).toEqual({ y: 2026, m: 9, d: 15 });
    expect(i.diasDesdeAbertura).toBe(27);
    expect(i.diasParaAbrir).toBe(3);
    expect(i.proximaAbertura).toEqual({ y: 2026, m: 10, d: 15 });
  });

  it("vira o ano", () => {
    const i = cicloInfo(6, { y: 2026, m: 12, d: 20 });
    expect(i.proximaAbertura).toEqual({ y: 2027, m: 1, d: 6 });
    const j = cicloInfo(15, { y: 2027, m: 1, d: 3 });
    expect(j.ultimaAbertura).toEqual({ y: 2026, m: 12, d: 15 });
  });

  it("mês curto: dia 31 vale o último dia do mês", () => {
    expect(cicloInfo(31, { y: 2026, m: 11, d: 30 }).diasDesdeAbertura).toBe(0);
    expect(cicloInfo(31, { y: 2027, m: 2, d: 28 }).diasDesdeAbertura).toBe(0);
    expect(cicloInfo(31, { y: 2026, m: 11, d: 29 }).diasParaAbrir).toBe(1);
  });
});

describe("diasAberturaNaFaixa", () => {
  it("quem abriu há 0 a 2 dias (hoje = dia 12)", () => {
    expect(diasAberturaNaFaixa({ min: 0, max: 2 }, "abriuHa", { y: 2026, m: 10, d: 12 }).sort((a, b) => a - b)).toEqual([10, 11, 12]);
  });
  it("quem abre em 1 a 3 dias", () => {
    expect(diasAberturaNaFaixa({ min: 1, max: 3 }, "abreEm", { y: 2026, m: 10, d: 12 }).sort((a, b) => a - b)).toEqual([13, 14, 15]);
  });
  it("atravessa o fim do mês", () => {
    expect(diasAberturaNaFaixa({ min: 1, max: 3 }, "abreEm", { y: 2026, m: 10, d: 30 }).sort((a, b) => a - b)).toEqual([1, 2, 31]);
  });
});

describe("helpers", () => {
  it("fechamento é o dia anterior", () => {
    expect(diaFechamentoPadrao(15)).toBe(14);
    expect(diaFechamentoPadrao(1)).toBe(31);
  });
  it("valida dia de abertura", () => {
    expect(validDiaAbertura(15)).toBe(true);
    expect(validDiaAbertura(0)).toBe(false);
    expect(validDiaAbertura(32)).toBe(false);
    expect(validDiaAbertura("15")).toBe(false);
  });
});

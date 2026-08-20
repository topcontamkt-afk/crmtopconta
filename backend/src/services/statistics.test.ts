import { computeABSignificance } from "./statistics";

describe("computeABSignificance", () => {
  it("marca como dado insuficiente quando a amostra é pequena", () => {
    const result = computeABSignificance(10, 3, 10, 5);
    expect(result.insufficientData).toBe(true);
    expect(result.significant95).toBe(false);
  });

  it("não é significativo quando as taxas de conversão são praticamente iguais", () => {
    const result = computeABSignificance(500, 50, 500, 51);
    expect(result.insufficientData).toBe(false);
    expect(result.significant95).toBe(false);
    expect(result.pValue).toBeGreaterThan(0.05);
  });

  it("é significativo quando há uma diferença grande e amostra suficiente", () => {
    // A: 10% de conversão, B: 30% de conversão, 500 por variante — diferença clara
    const result = computeABSignificance(500, 50, 500, 150);
    expect(result.insufficientData).toBe(false);
    expect(result.significant95).toBe(true);
    expect(result.pValue).not.toBeNull();
    expect(result.pValue!).toBeLessThan(0.05);
    expect(result.conversionRateA).toBeCloseTo(0.1);
    expect(result.conversionRateB).toBeCloseTo(0.3);
  });

  it("lida com taxas de conversão zero em ambas as variantes sem dividir por zero", () => {
    const result = computeABSignificance(100, 0, 100, 0);
    expect(result.insufficientData).toBe(false);
    expect(result.pValue).toBe(1);
    expect(result.significant95).toBe(false);
  });
});

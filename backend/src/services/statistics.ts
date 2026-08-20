/**
 * Significância estatística para A/B testing (Fase 3 — recorte leve, sem dependências externas).
 * Teste de duas proporções (two-proportion z-test) comparando a taxa de conversão da variante A
 * contra a B. Não requer nenhuma biblioteca de estatística: a função erro (erf) é aproximada
 * pela fórmula de Abramowitz & Stegun (precisão suficiente para decidir significância a 95%).
 */

export interface ABTestResult {
  conversionRateA: number; // 0-1
  conversionRateB: number; // 0-1
  zScore: number | null;
  pValue: number | null;
  significant95: boolean; // p < 0.05
  insufficientData: boolean; // amostra pequena demais para conclusão confiável
}

/** Aproximação numérica da função erro (Abramowitz & Stegun 7.1.26, erro máximo ~1.5e-7). */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

/** CDF da normal padrão via erf. */
function standardNormalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * @param sentA número de mensagens enviadas na variante A
 * @param convA número de conversões na variante A
 * @param sentB número de mensagens enviadas na variante B
 * @param convB número de conversões na variante B
 * @param minSampleSize amostra mínima por variante para considerar o resultado confiável (default 30)
 */
export function computeABSignificance(
  sentA: number,
  convA: number,
  sentB: number,
  convB: number,
  minSampleSize = 30
): ABTestResult {
  const rateA = sentA > 0 ? convA / sentA : 0;
  const rateB = sentB > 0 ? convB / sentB : 0;

  if (sentA < minSampleSize || sentB < minSampleSize) {
    return {
      conversionRateA: rateA,
      conversionRateB: rateB,
      zScore: null,
      pValue: null,
      significant95: false,
      insufficientData: true,
    };
  }

  const pooled = (convA + convB) / (sentA + sentB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / sentA + 1 / sentB));

  if (se === 0) {
    return {
      conversionRateA: rateA,
      conversionRateB: rateB,
      zScore: 0,
      pValue: 1,
      significant95: false,
      insufficientData: false,
    };
  }

  const z = (rateA - rateB) / se;
  const pValue = 2 * (1 - standardNormalCdf(Math.abs(z))); // teste bicaudal

  return {
    conversionRateA: rateA,
    conversionRateB: rateB,
    zScore: z,
    pValue,
    significant95: pValue < 0.05,
    insufficientData: false,
  };
}

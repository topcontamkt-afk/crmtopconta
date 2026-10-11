/**
 * Cálculo de percentual de uso do limite e categorização em faixas.
 * Regra de negócio (PRD): percentual_utilizado = (valor_utilizado / limite_total) * 100
 * Divisão segura: limite_total <= 0 => percentual = 0 e faixa = INDEFINIDO (evita divisão por zero
 * e evita classificar erroneamente um cadastro com dado ausente como "não utilizou").
 */

export type UsageFaixa =
  | "SEM_USO"
  | "USO_1_10"
  | "USO_11_20"
  | "USO_21_30"
  | "USO_31_50"
  | "USO_51_70"
  | "USO_71_99"
  | "USO_100"
  | "INDEFINIDO";

export interface UsageResult {
  percentual: number; // 0-100, 2 casas decimais
  faixa: UsageFaixa;
}

export function calculatePercentualUtilizado(
  limiteTotal: number,
  valorUtilizado: number
): number {
  if (!limiteTotal || limiteTotal <= 0) return 0;
  const pct = (valorUtilizado / limiteTotal) * 100;
  if (!isFinite(pct) || pct < 0) return 0;
  return Math.round(pct * 100) / 100;
}

/**
 * Faixas mutuamente exclusivas, aplicação determinística (ordem importa: primeira
 * condição verdadeira vence). Limiares podem ser ajustados via config futura por tenant.
 */
export function categorizeFaixa(
  percentual: number,
  limiteTotal: number
): UsageFaixa {
  if (!limiteTotal || limiteTotal <= 0) return "INDEFINIDO";
  if (percentual <= 0) return "SEM_USO";
  if (percentual <= 10) return "USO_1_10";
  if (percentual <= 20) return "USO_11_20";
  if (percentual <= 30) return "USO_21_30";
  if (percentual <= 50) return "USO_31_50";
  if (percentual <= 70) return "USO_51_70";
  if (percentual < 100) return "USO_71_99";
  return "USO_100";
}

export function computeUsage(limiteTotal: number, valorUtilizado: number): UsageResult {
  const percentual = calculatePercentualUtilizado(limiteTotal, valorUtilizado);
  const faixa = categorizeFaixa(percentual, limiteTotal);
  return { percentual, faixa };
}

export const FAIXA_LABELS: Record<UsageFaixa, string> = {
  SEM_USO: "0% (sem uso)",
  USO_1_10: "1 a 10%",
  USO_11_20: "11 a 20%",
  USO_21_30: "21 a 30%",
  USO_31_50: "31 a 50%",
  USO_51_70: "51 a 70%",
  USO_71_99: "71 a 99%",
  USO_100: "100% (limite esgotado)",
  INDEFINIDO: "Sem limite cadastrado",
};

/** Ordem de exibição das faixas (da menor para a maior utilização). */
export const FAIXA_ORDER: UsageFaixa[] = [
  "SEM_USO", "USO_1_10", "USO_11_20", "USO_21_30", "USO_31_50", "USO_51_70", "USO_71_99", "USO_100", "INDEFINIDO",
];

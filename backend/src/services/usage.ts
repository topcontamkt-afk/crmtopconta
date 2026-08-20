/**
 * Cálculo de percentual de uso do limite e categorização em faixas.
 * Regra de negócio (PRD): percentual_utilizado = (valor_utilizado / limite_total) * 100
 * Divisão segura: limite_total <= 0 => percentual = 0 e faixa = INDEFINIDO (evita divisão por zero
 * e evita classificar erroneamente um cadastro com dado ausente como "não utilizou").
 */

export type UsageFaixa =
  | "NAO_UTILIZOU"
  | "BAIXO_USO"
  | "USO_INICIAL"
  | "USO_INTERMEDIARIO"
  | "USO_ALTO"
  | "QUASE_COMPLETO"
  | "LIMITE_COMPLETO"
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
  if (percentual <= 0) return "NAO_UTILIZOU";
  if (percentual < 20) return "BAIXO_USO";
  if (percentual < 40) return "USO_INICIAL";
  if (percentual < 70) return "USO_INTERMEDIARIO";
  if (percentual < 90) return "USO_ALTO";
  if (percentual < 100) return "QUASE_COMPLETO";
  return "LIMITE_COMPLETO";
}

export function computeUsage(limiteTotal: number, valorUtilizado: number): UsageResult {
  const percentual = calculatePercentualUtilizado(limiteTotal, valorUtilizado);
  const faixa = categorizeFaixa(percentual, limiteTotal);
  return { percentual, faixa };
}

export const FAIXA_LABELS: Record<UsageFaixa, string> = {
  NAO_UTILIZOU: "Não utilizou",
  BAIXO_USO: "Baixo uso",
  USO_INICIAL: "Uso inicial",
  USO_INTERMEDIARIO: "Uso intermediário",
  USO_ALTO: "Uso alto",
  QUASE_COMPLETO: "Quase completo",
  LIMITE_COMPLETO: "Limite completo",
  INDEFINIDO: "Indefinido (sem limite cadastrado)",
};

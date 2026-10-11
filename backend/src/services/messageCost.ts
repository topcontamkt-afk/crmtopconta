/**
 * Custo estimado por mensagem do WhatsApp (tabela de preços da Meta, cobrada por mensagem de template
 * e por categoria). É uma ESTIMATIVA para o assistente de campanhas: os valores são configuráveis por
 * empresa (Tenant.custoMarketingUsd/custoUtilidadeUsd/cambioUsdBrl) porque a Meta reajusta a tabela.
 * O padrão de marketing e o câmbio vêm do valor que a operação já usa hoje (R$ 0,41 com câmbio 4,99).
 */
export const DEFAULT_COSTS = { marketingUsd: 0.0822, utilidadeUsd: null as number | null, cambioUsdBrl: 4.99 };

export interface CostConfig {
  marketingUsd: number | null;
  utilidadeUsd: number | null;
  cambioUsdBrl: number;
}

export function costConfigFrom(t: { custoMarketingUsd?: unknown; custoUtilidadeUsd?: unknown; cambioUsdBrl?: unknown } | null | undefined): CostConfig {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    marketingUsd: num(t?.custoMarketingUsd) ?? DEFAULT_COSTS.marketingUsd,
    utilidadeUsd: num(t?.custoUtilidadeUsd) ?? DEFAULT_COSTS.utilidadeUsd,
    cambioUsdBrl: num(t?.cambioUsdBrl) ?? DEFAULT_COSTS.cambioUsdBrl,
  };
}

export interface CostEstimate {
  categoria: string | null;
  usd: number | null;
  brl: number | null; // por mensagem
  total: number | null; // em reais
}

export function estimateCost(categoria: string | null | undefined, cfg: CostConfig, contatos: number): CostEstimate {
  const cat = (categoria ?? "").toUpperCase();
  const usd = cat === "MARKETING" ? cfg.marketingUsd : cat === "UTILITY" ? cfg.utilidadeUsd : null;
  if (usd === null || !(cfg.cambioUsdBrl > 0)) return { categoria: cat || null, usd: null, brl: null, total: null };
  const brl = Math.round(usd * cfg.cambioUsdBrl * 10_000) / 10_000;
  return { categoria: cat, usd, brl, total: Math.round(brl * contatos * 100) / 100 };
}

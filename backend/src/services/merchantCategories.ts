/**
 * Categorias de comércio credenciado. A planilha ("Todas as Compras") só traz o NomeFantasia do
 * lojista — não existe coluna de categoria —, então a categoria é deduzida do nome por regras
 * simples (primeira regra que casar vence) e pode ser corrigida à mão na tela de Comércio
 * (Merchant.categorySource = MANUAL nunca é sobrescrito por uma reimportação).
 */
export const MERCHANT_CATEGORIES = [
  { key: "SUPERMERCADO", label: "Supermercado e mercado" },
  { key: "POSTO", label: "Posto de combustível" },
  { key: "FARMACIA", label: "Farmácia e drogaria" },
  { key: "ACOUGUE", label: "Açougue, frios e pescados" },
  { key: "PADARIA", label: "Padaria e confeitaria" },
  { key: "VESTUARIO", label: "Moda e vestuário" },
  { key: "CONSTRUCAO", label: "Material de construção" },
  { key: "PAPELARIA", label: "Papelaria e armarinho" },
  { key: "AUTOPECAS", label: "Autopeças e oficina" },
  { key: "ACADEMIA", label: "Academia e bem-estar" },
  { key: "GAS_AGUA", label: "Gás e água" },
  { key: "OUTROS", label: "Outros" },
] as const;

export type MerchantCategory = (typeof MERCHANT_CATEGORIES)[number]["key"];

export const MERCHANT_CATEGORY_KEYS: string[] = MERCHANT_CATEGORIES.map((c) => c.key);

export function isMerchantCategory(value: string): value is MerchantCategory {
  return MERCHANT_CATEGORY_KEYS.includes(value);
}

/** Minúsculas, sem acento, espaços colapsados — chave de comparação e de dedupe de lojista. */
export function normalizeMerchantName(name: string): string {
  return (name || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// A ordem importa: regras mais específicas antes das genéricas (ex.: "Supermercado e Panificação"
// é supermercado, não padaria; "Auto Posto" é posto, não autopeças).
const RULES: { category: MerchantCategory; patterns: RegExp[] }[] = [
  { category: "POSTO", patterns: [/\bposto\b/, /combustiv/, /gasolina/] },
  { category: "SUPERMERCADO", patterns: [/supermercado/, /mercado/, /mercadinho/, /mercante/, /mercearia/, /supersam/, /hortifruti/, /atacado/, /atacarejo/] },
  { category: "FARMACIA", patterns: [/drogaria/, /drogavan/, /farmac/, /\bfarma\b/, /droga\b/] },
  { category: "ACOUGUE", patterns: [/acougue/, /\bcarnes?\b/, /\bfrios\b/, /pescado/, /peixaria/, /camarao/, /frigorific/, /\bgalinha\b/] },
  { category: "PADARIA", patterns: [/padaria/, /panificacao/, /confeitaria/, /\bpaes?\b/, /\bpao\b/] },
  { category: "PAPELARIA", patterns: [/papelaria/, /aviamento/, /armarinho/, /livraria/] },
  { category: "CONSTRUCAO", patterns: [/construcao/, /\bmateriais?\b/, /madeireira/, /ferragens?/, /\btintas?\b/] },
  { category: "AUTOPECAS", patterns: [/pecas?\b/, /autopecas/, /\bmoto(s|peças)?\b/, /oficina/, /mecanica/, /borracharia/, /\bpneus?\b/] },
  { category: "ACADEMIA", patterns: [/academia/, /fitness/, /crossfit/] },
  { category: "GAS_AGUA", patterns: [/naturalgas/, /\bgas\b/, /\bagua\b/] },
  { category: "VESTUARIO", patterns: [/\bmoda\b/, /confec/, /boutique/, /calcados?/, /roupas?/, /vestuario/, /lingerie/] },
];

export function categorizeMerchant(name: string): MerchantCategory {
  const key = normalizeMerchantName(name);
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(key))) return rule.category;
  }
  return "OUTROS";
}

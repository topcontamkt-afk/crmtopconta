/** Variáveis aceitas nos textos de campanha/template: {{nome}}, {{cidade}}, {{percentual}}, {{saldo}}, {{limite}}, {{limite_disponivel}} (mesmo valor de saldo: o limite que o cliente ainda pode usar). */
export const TEMPLATE_VARIABLES = ["nome", "cidade", "percentual", "saldo", "limite", "limite_disponivel"] as const;

/** Variáveis `{{x}}` usadas num texto (para validar mensagens sugeridas). */
export function variablesIn(text: string): string[] {
  return Array.from(text.matchAll(/\{\{\s*(\w+)\s*\}\}/g), (m) => m[1]);
}

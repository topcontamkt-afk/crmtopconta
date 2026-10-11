/** Cores, rótulos e séries compartilhadas pelo card do dashboard e pela página de perfis de renda. */
export const PERFIL_COR: Record<string, string> = { PF1: "#4f7cff", PF2: "#ff6907", PF3: "#35c17a", PF4: "#9b87f5" };
export const PERFIL_FAIXA: Record<string, string> = {
  PF1: "até R$ 4.000",
  PF2: "R$ 4.001 a 8.000",
  PF3: "R$ 8.001 a 12.000",
  PF4: "R$ 12.001 a 100.000",
};
export const PERFIS = ["PF1", "PF2", "PF3", "PF4"] as const;

export const ETAPA_LABEL: Record<string, string> = {
  NUNCA_USOU: "Nunca usou",
  RECORRENTE: "Recorrente",
  OCASIONAL: "Ocasional",
  EM_RISCO: "Em risco (31–90 dias)",
  INATIVO: "Inativo (+90 dias)",
};
export const ETAPA_COR: Record<string, string> = {
  NUNCA_USOU: "#9aa4b8",
  RECORRENTE: "#35c17a",
  OCASIONAL: "#4f7cff",
  EM_RISCO: "#e0a233",
  INATIVO: "#e15b5b",
};
export const ETAPAS = ["NUNCA_USOU", "RECORRENTE", "OCASIONAL", "EM_RISCO", "INATIVO"] as const;

export const fmtInt = (n: number) => n.toLocaleString("pt-BR");
export const fmtBRL = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
export const fmtPct = (n: number, t: number) => (t > 0 ? `${((n / t) * 100).toFixed(1).replace(".", ",")}%` : "0%");

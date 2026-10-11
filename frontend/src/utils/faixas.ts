/** Faixas de uso do limite (Client.faixaUso) — mesma regra de backend/src/services/usage.ts. */
export const FAIXA_OPTIONS = [
  { value: "SEM_USO", label: "0% (sem uso)" },
  { value: "USO_1_10", label: "1 a 10%" },
  { value: "USO_11_20", label: "11 a 20%" },
  { value: "USO_21_30", label: "21 a 30%" },
  { value: "USO_31_50", label: "31 a 50%" },
  { value: "USO_51_70", label: "51 a 70%" },
  { value: "USO_71_99", label: "71 a 99%" },
  { value: "USO_100", label: "100% (limite esgotado)" },
] as const;

export const FAIXA_LABELS: Record<string, string> = {
  ...Object.fromEntries(FAIXA_OPTIONS.map((f) => [f.value, f.label])),
  INDEFINIDO: "Sem limite cadastrado",
};

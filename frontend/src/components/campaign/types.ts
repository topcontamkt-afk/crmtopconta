export interface WaTemplate {
  id: string;
  name: string;
  body: string;
  metaBody?: string | null;
  variableMap?: (string | null)[] | null;
  variaveis: string[];
  variaveisSemMapa: number[];
  status: string;
  metaStatus: string | null;
  category: string | null;
  footer: string | null;
  quickReplies: string[] | null;
  buttons?: { type: string; text: string; url?: string; phone?: string }[] | null;
  headerFormat?: string | null;
  imagem?: { mime: string; size: number; filename: string } | null;
  origin?: string;
  sendIssue?: string | null;
  qualityScore: string | null;
  updatedAt?: string;
  channel?: "WHATSAPP" | "SMS";
  rejectionReason?: string | null;
  version?: number;
  metaName?: string | null;
  language?: string;
}

export interface Check {
  id: string;
  nivel: "ok" | "aviso" | "erro";
  titulo: string;
  detalhe?: string;
}

export interface Validation {
  contatos: number;
  total: number;
  checks: Check[];
  custo: { categoria: string | null; brl: number | null; total: number | null; usd: number | null; cambio: number };
  podeLancar: boolean;
  motivos: { linha: number; motivo: string }[];
}

export interface PlanilhaRow {
  nome: string;
  telefone: string;
  cpf: string;
  limiteDisponivel: string;
}

export const VARIAVEIS_NOSSAS: { key: string; label: string }[] = [
  { key: "nome", label: "Nome do cliente" },
  { key: "cidade", label: "Cidade" },
  { key: "percentual", label: "% do limite usado" },
  { key: "limite_disponivel", label: "Limite disponível" },
  { key: "saldo", label: "Saldo disponível" },
  { key: "limite", label: "Limite total" },
];

export const SAMPLE_CTX: Record<string, string> = {
  nome: "Maria",
  cidade: "Natal",
  percentual: "45",
  saldo: "R$ 850,00",
  limite: "R$ 1.500,00",
  limite_disponivel: "R$ 850,00",
};

/** Texto do template com dados de exemplo (importado: pelas posições; nosso: pelos nomes). */
export function renderSample(t: Pick<WaTemplate, "body" | "metaBody" | "variableMap">, ctx: Record<string, string>): string {
  if (t.metaBody && Array.isArray(t.variableMap)) {
    return t.metaBody.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => {
      const v = t.variableMap![Number(n) - 1];
      return v ? ctx[v] ?? "" : `{{${n}}}`;
    });
  }
  return t.body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => ctx[k] ?? "");
}

export const brl = (n: number | null | undefined, digits = 2) =>
  n === null || n === undefined ? "—" : n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: digits, maximumFractionDigits: Math.max(digits, 2) });

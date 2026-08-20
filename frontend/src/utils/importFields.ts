import { normalizeHeader } from "./csv";

/**
 * Campos aceitos pela importação (mesmos de backend/src/services/importService.ts —
 * RawSheetRow). `synonyms` cobre variações comuns de nome de coluna em planilhas reais
 * (com/sem acento, com espaço, abreviações) para o auto-mapeamento do upload direto.
 */
export interface ImportFieldDef {
  key: string;
  label: string;
  required: boolean;
  synonyms: string[];
}

export const IMPORT_FIELDS: ImportFieldDef[] = [
  { key: "id_cliente", label: "ID do cliente", required: true, synonyms: ["id_cliente", "id", "idcliente", "codigo", "codigo_cliente", "cod_cliente"] },
  { key: "nome", label: "Nome", required: true, synonyms: ["nome", "nome_cliente", "cliente", "nome_completo"] },
  { key: "telefone", label: "Telefone", required: true, synonyms: ["telefone", "fone", "celular", "whatsapp", "telefone_celular", "numero"] },
  { key: "cpf", label: "CPF", required: true, synonyms: ["cpf", "documento", "cpf_cnpj"] },
  { key: "cidade", label: "Cidade", required: false, synonyms: ["cidade", "municipio"] },
  { key: "data_cadastro", label: "Data de cadastro", required: false, synonyms: ["data_cadastro", "cadastro", "data_de_cadastro"] },
  { key: "data_abertura_conta", label: "Data de abertura da conta", required: false, synonyms: ["data_abertura_conta", "data_abertura", "abertura_conta", "data_de_abertura_da_conta"] },
  { key: "limite_total", label: "Limite total", required: false, synonyms: ["limite_total", "limite", "limite_de_credito"] },
  { key: "valor_utilizado", label: "Valor utilizado", required: false, synonyms: ["valor_utilizado", "utilizado", "valor_usado"] },
  { key: "saldo_disponivel", label: "Saldo disponível", required: false, synonyms: ["saldo_disponivel", "saldo", "saldo_disponivel_"] },
  { key: "valor_antecipado", label: "Valor antecipado", required: false, synonyms: ["valor_antecipado", "antecipado"] },
  { key: "data_ultima_utilizacao", label: "Data da última utilização", required: false, synonyms: ["data_ultima_utilizacao", "ultima_utilizacao", "ultimo_uso", "data_ultimo_uso"] },
  { key: "status_conta", label: "Status da conta", required: false, synonyms: ["status_conta", "status", "status_da_conta", "situacao"] },
  { key: "origem_cliente", label: "Origem do cliente", required: false, synonyms: ["origem_cliente", "origem"] },
  { key: "autorizacao_comunicacao", label: "Autorização de comunicação (LGPD)", required: false, synonyms: ["autorizacao_comunicacao", "autorizacao", "opt_in", "aceite_lgpd", "lgpd"] },
];

/** Para cada campo, encontra o índice da coluna do CSV cujo cabeçalho normalizado bate com algum sinônimo. */
export function autoMapColumns(headers: string[]): Record<string, number> {
  const normalized = headers.map(normalizeHeader);
  const mapping: Record<string, number> = {};
  for (const field of IMPORT_FIELDS) {
    const idx = normalized.findIndex((h) => field.synonyms.includes(h));
    if (idx !== -1) mapping[field.key] = idx;
  }
  return mapping;
}

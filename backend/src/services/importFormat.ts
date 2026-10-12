/**
 * Reconhece o formato de uma planilha pelos cabeçalhos, para barrar o erro de importar um arquivo
 * pelo formato errado (ex.: compras importadas como "Cartões e contas", que zerou limite e saldo).
 * Puro: a mesma regra existe no frontend (utils/importFormat.ts) para avisar antes de enviar; aqui é a
 * segunda trava, no servidor. Cabeçalhos são comparados normalizados (sem acento, minúsculos, `_`).
 */

export type ImportFormat = "cartoes" | "generico" | "compras";
export type DetectedFormat = ImportFormat | "desconhecido";

export const FORMAT_LABEL: Record<ImportFormat | "google_sheets", string> = {
  cartoes: "Cartões e contas",
  generico: "Genérico",
  compras: "Compras",
  google_sheets: "Google Sheets",
};

export function normalizeHeader(s: string): string {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const COMPRAS_ID = ["idtransacaocartao", "id_transacao_cartao", "idtransacao", "id_transacao"];
const COMPRAS_VALOR = ["valorprincipal", "valor_principal", "valorparcela", "valor_parcela", "juros", "dtconfirmada", "dt_confirmada"];
// Colunas que só existem na planilha de cartões e contas (não aparecem em compras nem no genérico)
const CARTOES_SINAIS = [
  "limitedecompras", "limite_de_compras", "limitetotal", "saldodisponivel", "saldoutilizado", "saldo_utilizado", "valorutilizado", "dtativacaocartao", "dt_ativacao_cartao",
  "dtsoliccadastro", "dt_solic_cadastro", "idcartao", "id_cartao", "statuscadastro", "status_cadastro", "cartaobloqueado", "cartao_bloqueado",
  "contabloqueada", "conta_bloqueada", "datavalidade", "data_validade", "lotacao", "saldoliquidosaque", "remuneracaobruta",
];
const GENERICO_SINAIS = ["id_cliente", "idcliente", "status_conta", "limite_total", "valor_utilizado", "saldo_disponivel", "valor_antecipado", "autorizacao_comunicacao", "origem_cliente", "data_abertura_conta"];

export function detectFormat(headers: string[]): DetectedFormat {
  const h = new Set(headers.map(normalizeHeader).filter(Boolean));
  const has = (list: string[]) => list.filter((x) => h.has(x)).length;

  if (has(COMPRAS_ID) > 0 && has(COMPRAS_VALOR) > 0) return "compras";
  const cartoes = has(CARTOES_SINAIS);
  const generico = has(GENERICO_SINAIS);
  if (cartoes >= 2 && cartoes > generico) return "cartoes";
  if (generico >= 2 && generico >= cartoes) return "generico";
  if (cartoes >= 2) return "cartoes";
  return "desconhecido";
}

/** Mensagem quando o formato escolhido não é o do arquivo; null se está tudo certo (ou não dá para saber). */
export function formatMismatch(chosen: ImportFormat, headers: string[]): { detectado: ImportFormat; mensagem: string } | null {
  const detectado = detectFormat(headers);
  if (detectado === "desconhecido" || detectado === chosen) return null;
  return {
    detectado,
    mensagem: `Este arquivo parece ser do formato "${FORMAT_LABEL[detectado]}", mas você escolheu "${FORMAT_LABEL[chosen]}". Escolha o formato certo antes de importar.`,
  };
}

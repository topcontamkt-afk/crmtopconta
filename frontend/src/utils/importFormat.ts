import { normalizeHeader } from "./csv";

/**
 * Reconhece o formato da planilha pelos cabeçalhos, para avisar ANTES de enviar quando o arquivo é de
 * outro formato (ex.: compras importadas como "Cartões e contas", que zerou limite e saldo). Mesma regra
 * de backend/src/services/importFormat.ts, que é a segunda trava no servidor (os pacotes são independentes).
 */
export type ImportFormat = "cartoes" | "generico" | "compras";
export type DetectedFormat = ImportFormat | "desconhecido";

export const FORMAT_LABEL: Record<ImportFormat, string> = {
  cartoes: "Cartões e contas",
  generico: "Genérico",
  compras: "Compras",
};

const COMPRAS_ID = ["idtransacaocartao", "id_transacao_cartao", "idtransacao", "id_transacao"];
const COMPRAS_VALOR = ["valorprincipal", "valor_principal", "valorparcela", "valor_parcela", "juros", "dtconfirmada", "dt_confirmada"];
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

/** Presença por ARQUIVO inteiro: a coluna conta como presente se ao menos uma célula tem valor. */
export function hasValue(rows: string[][], idx: number | undefined): boolean {
  if (idx === undefined) return false;
  return rows.some((r) => (r[idx] ?? "").trim() !== "");
}

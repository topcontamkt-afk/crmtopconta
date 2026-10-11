/**
 * Classificação do tipo de operação do extrato de transações do cartão (Purchase.tipo, a coluna
 * "Descricao" da planilha), em código puro e sem banco. A importação e o parsing de datas/valores
 * ficam com purchaseImport.ts/purchaseParsing.ts; aqui só se decide o que conta como USO.
 *
 * Regras de negócio confirmadas com o cliente (2026-10-10):
 *  - "Débito Pix Cartão" = saque/antecipação salarial com taxa de juros; `Juros` é o lucro.
 *  - "Compra à Vista Cartão Top Convênio" = compra no comércio credenciado; a taxa é paga pelo
 *    comerciante e não temos esse dado (lucro desconhecido, não zero).
 *  - "Assinatura AMEF-Gleebem" = mensalidade fixa do benefício; cobrança automática, sem lucro e
 *    sem decisão do cliente — NUNCA conta como uso (senão toda campanha "converteria" com a
 *    mensalidade).
 *  - Qualquer outra descrição (saque avulso, débito de fatura, estorno...) é OUTRO e não conta como
 *    uso até alguém classificar — um tipo desconhecido jamais pode inflar conversão em silêncio.
 *    O pagamento da fatura é desconto automático em folha, não decisão do cliente.
 */

export type TransactionKind = "ANTECIPACAO" | "COMPRA" | "ASSINATURA" | "OUTRO";

export interface TransactionClassification {
  kind: TransactionKind;
  /** true só para ações iniciadas pelo cliente (antecipação e compra). */
  countsAsUsage: boolean;
}

/** minúsculas, sem acento, espaços colapsados — para o casamento não depender de digitação. */
export function normalizeDescricao(value: string): string {
  return (value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyTransaction(descricao: string): TransactionClassification {
  const d = normalizeDescricao(descricao);
  if (d.startsWith("debito pix")) return { kind: "ANTECIPACAO", countsAsUsage: true };
  if (d.startsWith("compra a vista")) return { kind: "COMPRA", countsAsUsage: true };
  if (d.startsWith("assinatura")) return { kind: "ASSINATURA", countsAsUsage: false };
  return { kind: "OUTRO", countsAsUsage: false };
}

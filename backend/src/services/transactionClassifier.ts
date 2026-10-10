/**
 * Classificação e parsing do extrato de transações do cartão (código puro, sem banco — ver
 * transactionImport.ts para a importação em si).
 *
 * Regras de negócio confirmadas com o cliente (2026-10-10):
 *  - "Débito Pix Cartão" = saque/antecipação salarial com taxa de juros; `Juros` é o lucro.
 *  - "Compra à Vista Cartão Top Convênio" = compra no comércio credenciado; a taxa é paga pelo
 *    comerciante e não temos esse dado (lucro desconhecido, não zero).
 *  - "Assinatura AMEF-Gleebem" = mensalidade fixa do benefício; cobrança automática, sem lucro e
 *    sem decisão do cliente — NUNCA conta como uso (senão toda campanha "converteria" com a
 *    mensalidade).
 *  - Qualquer outra descrição é guardada como OUTRO e não conta como uso até alguém classificar —
 *    um tipo desconhecido jamais pode inflar conversão em silêncio.
 * Pagamento de fatura (desconto em folha) e estornos não aparecem neste extrato.
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
  if (d.startsWith("debito pix cartao")) return { kind: "ANTECIPACAO", countsAsUsage: true };
  if (d.startsWith("compra a vista")) return { kind: "COMPRA", countsAsUsage: true };
  if (d.startsWith("assinatura")) return { kind: "ASSINATURA", countsAsUsage: false };
  return { kind: "OUTRO", countsAsUsage: false };
}

/**
 * Brasília é UTC-3 o ano todo (sem horário de verão desde 2019). O extrato não traz fuso, então
 * data/hora sem offset explícito é lida como horário de Brasília e guardada em UTC.
 */
const BRASILIA_OFFSET_HOURS = 3;

function buildDate(y: number, mo: number, d: number, h: number, mi: number, s: number): Date | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const date = new Date(Date.UTC(y, mo - 1, d, h + BRASILIA_OFFSET_HOURS, mi, s));
  // Rejeita datas que "rolaram" (31/02 viraria 03/03): o dia local tem de bater com o informado.
  const local = new Date(date.getTime() - BRASILIA_OFFSET_HOURS * 3600 * 1000);
  if (local.getUTCFullYear() !== y || local.getUTCMonth() !== mo - 1 || local.getUTCDate() !== d) return null;
  return date;
}

/**
 * Aceita "dd/mm/yyyy[ hh:mm[:ss]]" (formato da planilha — SEMPRE dia primeiro, nunca mês) e ISO
 * ("yyyy-mm-dd[ T]hh:mm[:ss]", com ou sem "Z"/offset). Retorna null para qualquer outra coisa:
 * o `new Date("10/9/2026")` do JavaScript leria como 9 de outubro, o que corromperia a
 * atribuição de uso por dia.
 */
export function parseBrDateTime(value: string | undefined | null): Date | null {
  if (!value) return null;
  const v = String(value).trim();

  const br = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (br) {
    return buildDate(+br[3], +br[2], +br[1], +(br[4] ?? 0), +(br[5] ?? 0), +(br[6] ?? 0));
  }

  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/);
  if (iso) {
    const [, y, mo, d, h = "0", mi = "0", s = "0", tz] = iso;
    if (tz) {
      const parsed = new Date(v.replace(" ", "T"));
      return isNaN(parsed.getTime()) ? null : parsed;
    }
    return buildDate(+y, +mo, +d, +h, +mi, +s);
  }

  return null;
}

/**
 * Valor monetário de planilha brasileira: "356,5", "1.920,50", "R$ 29,90", "29.9", "-". Retorna
 * null se não der para interpretar (diferente de "-"/vazio, que é zero), para a linha ser
 * rejeitada em vez de gravar um valor errado.
 *
 * Ambiguidade tratada: só com ponto, "1.920" é milhar (1920) e "29.9"/"1.92" é decimal. Isto é
 * diferente de cardAccountImport.parseNumber, que apaga todo ponto — lá "29.9" viraria 299.
 */
export function parseMoney(value: string | number | undefined | null): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  let s = String(value).trim().replace(/^R\$\s*/i, "").replace(/\s/g, "");
  if (s === "" || s === "-") return 0;

  let negative = false;
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  } else if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }

  let normalized: string;
  if (s.includes(",")) {
    // vírgula é o decimal; pontos, se houver, são milhar
    if (!/^\d{1,3}(\.\d{3})*,\d+$|^\d+,\d+$/.test(s)) return null;
    normalized = s.replace(/\./g, "").replace(",", ".");
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    normalized = s.replace(/\./g, ""); // "1.920" / "1.234.567" — milhar
  } else if (/^\d+(\.\d+)?$/.test(s)) {
    normalized = s; // "29.9", "1.92" ou inteiro puro
  } else {
    return null;
  }

  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

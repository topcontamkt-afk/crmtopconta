import { digitsOnly } from "./masking";

/**
 * Parsing tolerante da aba "Todas as Compras". As colunas desta aba vêm no formato numérico dos
 * EUA ("R$ 1,591.00", "R$ 446.20"), diferente das outras abas (formato BR, "R$ 500,00") — então o
 * separador decimal é deduzido de cada valor, e não assumido.
 */
export function parseMoney(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return isFinite(raw) ? raw : null;
  let s = String(raw).replace(/R\$/gi, "").replace(/\s/g, "");
  if (s === "" || s === "-") return 0;
  const negative = s.startsWith("-") || /^\(.*\)$/.test(s);
  s = s.replace(/[-()]/g, "");
  if (!/^[\d.,]+$/.test(s)) return null;

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let decimalSep: "." | "," | null = null;
  if (lastDot !== -1 && lastComma !== -1) {
    decimalSep = lastDot > lastComma ? "." : ",";
  } else if (lastDot !== -1 || lastComma !== -1) {
    const sep = lastDot !== -1 ? "." : ",";
    const occurrences = s.split(sep).length - 1;
    const decimals = s.length - s.lastIndexOf(sep) - 1;
    // Um único separador seguido de 1-2 dígitos é decimal ("446.20", "500,00"); com 3 dígitos
    // ("1.500", "1,500") ou repetido ("1.234.567") é separador de milhar.
    if (occurrences === 1 && decimals >= 1 && decimals <= 2) decimalSep = sep;
  }

  let normalized: string;
  if (decimalSep) {
    const idx = s.lastIndexOf(decimalSep);
    const intPart = s.slice(0, idx).replace(/[.,]/g, "");
    const decPart = s.slice(idx + 1).replace(/[.,]/g, "");
    normalized = `${intPart || "0"}.${decPart}`;
  } else {
    normalized = s.replace(/[.,]/g, "");
  }
  const n = Number(normalized);
  if (!isFinite(n)) return null;
  return negative ? -n : n;
}

/** "15/06/2026 11:41:05" (horário de Brasília, UTC-3) ou ISO. Retorna null se não reconhecer. */
export function parsePurchaseDate(raw: unknown): Date | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const br = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (br) {
    const [, d, m, y, hh = "0", mm = "0", ss = "0"] = br;
    const pad = (v: string) => v.padStart(2, "0");
    const iso = `${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}:${pad(ss)}-03:00`;
    const date = new Date(iso);
    if (isNaN(date.getTime())) return null;
    // Rejeita datas que o JS "corrigiria" sozinho (31/02 virando 03/03).
    const check = new Date(date.getTime() - 3 * 60 * 60 * 1000);
    if (check.getUTCDate() !== Number(d) || check.getUTCMonth() + 1 !== Number(m)) return null;
    return date;
  }
  const date = new Date(s);
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Colunas numéricas de CPF/CNPJ costumam perder o zero à esquerda quando a planilha é exportada
 * (ex.: CPF com 10 dígitos). Recompõe o tamanho original: até 11 dígitos vira CPF, 12-14 vira CNPJ.
 */
export function normalizeDocumentDigits(raw: unknown): string | null {
  const digits = digitsOnly(String(raw ?? ""));
  if (digits.length === 0 || digits.length > 14) return null;
  return digits.length <= 11 ? digits.padStart(11, "0") : digits.padStart(14, "0");
}

/** Quais tipos de transação contam como "utilização" do cartão (alimenta dataUltimaUtilizacao). */
export function isUsageType(tipo: string): boolean {
  const t = tipo.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return t.startsWith("compra") || t.includes("saque") || t.includes("pix");
}

/** Compra feita num lojista do comércio credenciado (tem categoria; saque/Pix/assinatura não). */
export function isCommercePurchase(tipo: string): boolean {
  return tipo.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().startsWith("compra");
}

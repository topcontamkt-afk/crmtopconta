import crypto from "crypto";
import { parsePhoneNumberFromString } from "libphonenumber-js";

/**
 * LGPD — mascaramento e hashing de dados sensíveis.
 * CPF nunca é armazenado em texto plano: apenas hash (com salt por tenant, para
 * permitir dedupe sem expor o dado) + versão mascarada para exibição em UI.
 */

export function digitsOnly(value: string): string {
  return (value || "").replace(/\D/g, "");
}

export function isValidCPF(cpf: string): boolean {
  const digits = digitsOnly(cpf);
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false;

  const calcCheckDigit = (base: string, factor: number) => {
    let total = 0;
    for (const digit of base) {
      total += parseInt(digit, 10) * factor--;
    }
    const rest = (total * 10) % 11;
    return rest === 10 ? 0 : rest;
  };

  const d1 = calcCheckDigit(digits.substring(0, 9), 10);
  const d2 = calcCheckDigit(digits.substring(0, 10), 11);
  return d1 === parseInt(digits[9], 10) && d2 === parseInt(digits[10], 10);
}

export function maskCPF(cpf: string): string {
  const digits = digitsOnly(cpf);
  if (digits.length !== 11) return "***.***.***-**";
  return `***.${digits.substring(3, 6)}.***-${digits.substring(9, 11)}`;
}

/** Hash determinístico com salt por tenant — usado apenas para dedupe/lookup, nunca reversível. */
export function hashCPF(cpf: string, tenantSalt: string): string {
  const digits = digitsOnly(cpf);
  return crypto.createHmac("sha256", tenantSalt).update(digits).digest("hex");
}

export function isValidCNPJ(cnpj: string): boolean {
  const digits = digitsOnly(cnpj);
  if (digits.length !== 14 || /^(\d)\1{13}$/.test(digits)) return false;

  const calcCheckDigit = (base: string, weights: number[]) => {
    let total = 0;
    for (let i = 0; i < base.length; i++) total += parseInt(base[i], 10) * weights[i];
    const rest = total % 11;
    return rest < 2 ? 0 : 11 - rest;
  };

  const d1 = calcCheckDigit(digits.substring(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = calcCheckDigit(digits.substring(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d1 === parseInt(digits[12], 10) && d2 === parseInt(digits[13], 10);
}

export type DocumentType = "CPF" | "CNPJ";

/**
 * Base cadastral real (cartão/convênio) traz tanto CPF (pessoa física) quanto CNPJ (pessoa
 * jurídica) numa mesma coluna "CpfCnpjCliente" — estas funções generalizam a validação/
 * mascaramento/hash já existentes (CPF-only) para aceitar os dois, sem quebrar hashCPF/maskCPF/
 * isValidCPF (mantidas como estão, usadas pelos testes e pelo fluxo Google Sheets original).
 */
export function detectDocumentType(value: string): DocumentType | null {
  const digits = digitsOnly(value);
  if (digits.length === 11) return "CPF";
  if (digits.length === 14) return "CNPJ";
  return null;
}

export function isValidDocument(value: string): boolean {
  const type = detectDocumentType(value);
  if (type === "CPF") return isValidCPF(value);
  if (type === "CNPJ") return isValidCNPJ(value);
  return false;
}

export function maskDocument(value: string): string {
  const digits = digitsOnly(value);
  if (digits.length === 11) return maskCPF(value);
  if (digits.length === 14) return `**.***.${digits.substring(5, 8)}/****-${digits.substring(12, 14)}`;
  return "***";
}

/** Hash determinístico com salt por tenant — mesmo algoritmo de hashCPF, para CPF ou CNPJ. */
export function hashDocument(value: string, tenantSalt: string): string {
  const digits = digitsOnly(value);
  return crypto.createHmac("sha256", tenantSalt).update(digits).digest("hex");
}

/** Normaliza telefone para E.164 (default BR). Retorna null se inválido. */
export function normalizePhone(raw: string, defaultCountry: "BR" = "BR"): string | null {
  if (!raw) return null;
  const parsed = parsePhoneNumberFromString(raw, defaultCountry);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number; // formato E.164, ex: +5511999998888
}

export function maskPhone(phone: string): string {
  const digits = digitsOnly(phone);
  if (digits.length < 4) return "****";
  return `${"*".repeat(Math.max(digits.length - 4, 0))}${digits.slice(-4)}`;
}

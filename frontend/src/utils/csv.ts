/**
 * Parser de CSV client-side (upload direto de planilha — sem depender de nenhuma lib externa,
 * evita puxar pacotes como "xlsx" que hoje têm vulnerabilidades conhecidas sem correção
 * publicada no registro do npm). Suporta:
 *  - separador `,` ou `;` (Excel/Sheets em pt-BR costuma exportar CSV com `;`, já que `,` é o
 *    separador decimal do locale) — detectado automaticamente pela linha de cabeçalho.
 *  - campos entre aspas (com vírgula/ponto-e-vírgula/quebra de linha dentro) e aspas escapadas ("").
 */

function detectDelimiter(headerLine: string): "," | ";" {
  const commas = (headerLine.match(/,/g) || []).length;
  const semicolons = (headerLine.match(/;/g) || []).length;
  return semicolons > commas ? ";" : ",";
}

export function parseCsv(text: string): string[][] {
  // Remove BOM (comum em exports do Excel) e normaliza quebras de linha.
  const clean = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const firstLineEnd = clean.indexOf("\n");
  const headerLine = firstLineEnd === -1 ? clean : clean.slice(0, firstLineEnd);
  const delimiter = detectDelimiter(headerLine);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  function pushField() {
    row.push(field);
    field = "";
  }
  function pushRow() {
    pushField();
    rows.push(row);
    row = [];
  }

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      pushField();
    } else if (ch === "\n") {
      pushRow();
    } else {
      field += ch;
    }
  }
  // Última linha sem quebra final
  if (field !== "" || row.length > 0) pushRow();

  // Remove linhas totalmente vazias (comum no fim do arquivo)
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Normaliza um cabeçalho para comparação: minúsculas, sem acento, só letras/números/underscore. */
export function normalizeHeader(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

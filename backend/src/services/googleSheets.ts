import { google } from "googleapis";
import { RawSheetRow } from "./importService";

/**
 * Conector de Google Sheets.
 * Suporta Service Account (recomendado para sync automático/agendado) via
 * GOOGLE_SERVICE_ACCOUNT_JSON, ou OAuth2 (conta do próprio cliente) via
 * access/refresh token armazenados na SheetConnection (fora do escopo deste MVP).
 */

export interface ColumnMapping {
  [field: string]: string; // ex: { id_cliente: "A", nome: "B", ... }
}

function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON não configurado. Defina a credencial da Service Account " +
        "(Integrações → Google Sheets) para habilitar a sincronização automática."
    );
  }
  const credentials = JSON.parse(raw);
  return new google.auth.GoogleAuth({
    credentials,
    // Escopo de leitura+escrita: além de importar a base (Fase 1), a Service Account também
    // escreve o export/resumo agendado de volta na planilha (Fase 3 — conector BI leve).
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

/** Lê o range informado e converte para RawSheetRow[] usando o mapeamento de colunas. */
export async function fetchSheetRows(
  sheetId: string,
  range: string,
  mapping: ColumnMapping
): Promise<RawSheetRow[]> {
  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range,
  });

  const values = resp.data.values || [];
  if (values.length === 0) return [];

  const header = values[0].map((h) => String(h).trim());
  const dataRows = values.slice(1);

  const fieldByHeaderIndex: Record<number, string> = {};
  for (const [field, columnHeaderOrLetter] of Object.entries(mapping)) {
    let idx = header.indexOf(columnHeaderOrLetter);
    if (idx === -1 && /^[A-Z]+$/.test(columnHeaderOrLetter)) {
      idx = columnLetterToIndex(columnHeaderOrLetter);
    }
    if (idx !== -1) fieldByHeaderIndex[idx] = field;
  }

  return dataRows.map((r) => {
    const row: RawSheetRow = {};
    r.forEach((cell, idx) => {
      const field = fieldByHeaderIndex[idx];
      if (field) (row as any)[field] = cell;
    });
    return row;
  });
}

/**
 * Conector BI leve (Fase 3): escreve um resumo tabular numa aba dedicada da mesma planilha
 * usada para importação, substituindo o conteúdo anterior a cada execução (snapshot do dia).
 * Serve como alternativa simples a conectores de BI mais pesados (BigQuery/Data Studio), sem
 * exigir infraestrutura nova — reaproveita a Service Account já configurada.
 */
export async function writeSheetSummary(
  sheetId: string,
  tabName: string,
  rows: (string | number)[][]
): Promise<void> {
  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });

  // Garante que a aba de export existe antes de escrever nela.
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const exists = meta.data.sheets?.some((s) => s.properties?.title === tabName);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
  }

  // Limpa o conteúdo anterior e escreve o snapshot atual — mantém a aba sempre com o resumo
  // mais recente, sem acumular histórico infinito de linhas.
  await sheets.spreadsheets.values.clear({ spreadsheetId: sheetId, range: tabName });
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${tabName}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: rows },
  });
}

function columnLetterToIndex(letters: string): number {
  let idx = 0;
  for (const ch of letters) {
    idx = idx * 26 + (ch.charCodeAt(0) - 64);
  }
  return idx - 1;
}

export const DEFAULT_COLUMN_MAPPING: ColumnMapping = {
  id_cliente: "id_cliente",
  nome: "nome",
  telefone: "telefone",
  cpf: "cpf",
  cidade: "cidade",
  data_cadastro: "data_cadastro",
  data_abertura_conta: "data_abertura_conta",
  limite_total: "limite_total",
  valor_utilizado: "valor_utilizado",
  saldo_disponivel: "saldo_disponivel",
  valor_antecipado: "valor_antecipado",
  data_ultima_utilizacao: "data_ultima_utilizacao",
  status_conta: "status_conta",
  origem_cliente: "origem_cliente",
  autorizacao_comunicacao: "autorizacao_comunicacao",
};

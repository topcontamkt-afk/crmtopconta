import { google } from "googleapis";
import type { SheetConnection } from "../generated/prisma/client";
import { prisma, type AppPrismaClient } from "../config/db";
import { withCrossTenantAccess } from "../config/tenantGuard";
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

// LGPD 06-02: escopo mínimo por operação. Ler a base só precisa de leitura; só o export BI
// (writeSheetSummary: cria a aba, limpa e escreve o resumo) precisa de escrita. Um token de
// leitura não consegue alterar a planilha nem que a Service Account tenha sido compartilhada
// como Editor.
export const SCOPE_LEITURA = "https://www.googleapis.com/auth/spreadsheets.readonly";
export const SCOPE_ESCRITA = "https://www.googleapis.com/auth/spreadsheets";

function getAuth(scope: string) {
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
    scopes: [scope],
  });
}

/**
 * E-mail da Service Account (identificador público, não é segredo): é com ele que o controlador
 * compartilha a planilha. Nunca devolve a private_key. Null se a credencial não está configurada.
 */
export function serviceAccountEmail(): string | null {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const email = JSON.parse(raw).client_email;
    return typeof email === "string" ? email : null;
  } catch {
    return null;
  }
}

/** Aceita o link completo da planilha ou só o ID (mesma regra da tela de Integrações). */
export function extractSheetId(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : trimmed;
}

export class SheetAccessError extends Error {
  constructor(
    public status: number,
    public codigo: "PLANILHA_NAO_CADASTRADA" | "PLANILHA_EM_OUTRO_CONTROLADOR",
    message: string
  ) {
    super(message);
  }
}

const ERRO_NAO_CADASTRADA = () =>
  new SheetAccessError(
    403,
    "PLANILHA_NAO_CADASTRADA",
    "Planilha não cadastrada para esta conta. Um administrador precisa salvá-la em Integrações → Google Sheets antes de sincronizar."
  );

/**
 * LGPD 06-02: a Service Account é uma só para todos os tenants, então duas contas podem apontar
 * para a MESMA planilha (por engano ou de propósito) e ler os dados uma da outra. Não dá para
 * saber qual cadastro é o legítimo (o PUT /sheets atualiza a linha e mantém o createdAt antigo),
 * então a regra falha FECHADA: planilha cadastrada como ativa em mais de um tenant não é lida nem
 * escrita por nenhum deles até o operador resolver. A recusa no próprio cadastro (como já existe
 * para o phoneNumberId do WhatsApp) fica em routes/integrations.ts, fora deste lote.
 *
 * Cross-tenant de propósito: só devolve os tenantIds que cadastraram o sheetId, nada da planilha
 * nem do outro controlador.
 */
export async function assertPlanilhaExclusiva(prisma: AppPrismaClient, sheetId: string, tenantId?: string): Promise<void> {
  const rows = await withCrossTenantAccess(() =>
    prisma.sheetConnection.findMany({ where: { sheetId, active: true }, select: { tenantId: true } })
  );
  const donos = new Set(rows.map((r) => r.tenantId));
  if (donos.size === 0 || (tenantId && !donos.has(tenantId))) throw ERRO_NAO_CADASTRADA();
  if (donos.size > 1) {
    throw new SheetAccessError(
      409,
      "PLANILHA_EM_OUTRO_CONTROLADOR",
      "Esta planilha também está cadastrada em outra conta e, por segurança, não será lida por nenhuma delas. Confira o ID da planilha em Integrações ou fale com o suporte."
    );
  }
}

/**
 * LGPD 06-02: trava da importação manual. Só devolve a planilha CADASTRADA como SheetConnection
 * ativa do próprio tenant (cadastro só por ADMIN e auditado em PUT /api/integrations/sheets) e
 * exclusiva dele (assertPlanilhaExclusiva). Um sheetId qualquer, mesmo compartilhado com a
 * Service Account, não é mais aceito.
 */
export async function resolveTenantSheet(
  prisma: AppPrismaClient,
  tenantId: string,
  sheetId?: string
): Promise<SheetConnection> {
  const pedido = sheetId ? extractSheetId(sheetId) : undefined;
  const conn = await prisma.sheetConnection.findFirst({
    where: { tenantId, active: true, ...(pedido ? { sheetId: pedido } : {}) },
  });
  if (!conn) throw ERRO_NAO_CADASTRADA();
  await assertPlanilhaExclusiva(prisma, conn.sheetId, tenantId);
  return conn;
}

/** Lê o range informado e converte para RawSheetRow[] usando o mapeamento de colunas. */
export async function fetchSheetRows(
  sheetId: string,
  range: string,
  mapping: ColumnMapping
): Promise<RawSheetRow[]> {
  // LGPD 06-02: vale também para o sync agendado (scheduler.ts), que lê direto daqui.
  await assertPlanilhaExclusiva(prisma, sheetId);
  const auth = getAuth(SCOPE_LEITURA);
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
  // LGPD 06-02: o export BI (biExport.ts) não escreve numa planilha que outra conta também cadastrou.
  await assertPlanilhaExclusiva(prisma, sheetId);
  const auth = getAuth(SCOPE_ESCRITA);
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

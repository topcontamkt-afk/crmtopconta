import { PrismaClient } from "@prisma/client";
import { computeUsage } from "./usage";
import { digitsOnly, hashCPF, isValidCPF, maskCPF, normalizePhone } from "./masking";
import { findExistingClient, IncomingClientRow } from "./dedupe";

/**
 * Campos mínimos obrigatórios (PRD): id_cliente, nome, telefone, cpf, cidade,
 * data_cadastro, data_abertura_conta, limite_total, valor_utilizado, saldo_disponivel,
 * valor_antecipado, data_ultima_utilizacao, status_conta, origem_cliente,
 * autorizacao_comunicacao.
 */
export interface RawSheetRow {
  id_cliente?: string;
  nome?: string;
  telefone?: string;
  cpf?: string;
  cidade?: string;
  data_cadastro?: string;
  data_abertura_conta?: string;
  limite_total?: string | number;
  valor_utilizado?: string | number;
  saldo_disponivel?: string | number;
  valor_antecipado?: string | number;
  data_ultima_utilizacao?: string;
  status_conta?: string;
  origem_cliente?: string;
  autorizacao_comunicacao?: string | boolean;
}

interface RowError {
  row: number;
  motivo: string;
}

const REQUIRED_FIELDS: (keyof RawSheetRow)[] = [
  "id_cliente",
  "nome",
  "telefone",
  "cpf",
];

function parseDate(v?: string): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d;
}

function parseNumber(v?: string | number): number {
  if (v === undefined || v === null || v === "") return 0;
  if (typeof v === "number") return v;
  const n = Number(String(v).replace(/\./g, "").replace(",", "."));
  return isNaN(n) ? 0 : n;
}

function parseBool(v?: string | boolean): boolean {
  if (typeof v === "boolean") return v;
  if (!v) return false;
  return ["sim", "true", "1", "yes"].includes(String(v).trim().toLowerCase());
}

function parseStatus(v?: string): "ATIVO" | "INATIVO" | "BLOQUEADO" {
  const s = (v || "").trim().toLowerCase();
  if (s.startsWith("inat")) return "INATIVO";
  if (s.startsWith("bloq")) return "BLOQUEADO";
  return "ATIVO";
}

function validateRow(row: RawSheetRow, rowNumber: number): RowError | null {
  for (const field of REQUIRED_FIELDS) {
    if (!row[field] || String(row[field]).trim() === "") {
      return { row: rowNumber, motivo: `Campo obrigatório ausente: ${field}` };
    }
  }
  if (!isValidCPF(row.cpf!)) {
    return { row: rowNumber, motivo: "CPF inválido (checksum não confere)" };
  }
  return null;
}

export interface ImportRunResult {
  totalRows: number;
  addedCount: number;
  updatedCount: number;
  errorCount: number;
  errors: RowError[];
}

/**
 * Executa a importação de um lote de linhas já lidas da planilha (ou CSV).
 * Aplica: validação de campos obrigatórios + checksum de CPF, normalização de
 * telefone, hash/máscara de CPF, deduplicação (última atualização ganha),
 * cálculo de percentual_utilizado e faixa de uso.
 */
export async function runImport(
  prisma: PrismaClient,
  tenantId: string,
  rows: RawSheetRow[],
  triggeredBy: string,
  source: "google_sheets" | "csv" = "google_sheets",
  sheetId?: string
): Promise<{ importJobId: string; result: ImportRunResult }> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });

  const job = await prisma.importJob.create({
    data: { tenantId, source, sheetId, status: "EM_EXECUCAO", totalRows: rows.length, triggeredBy },
  });

  const errors: RowError[] = [];
  let added = 0;
  let updated = 0;

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const rowNumber = i + 2; // considerando linha 1 = cabeçalho da planilha
    const err = validateRow(raw, rowNumber);
    if (err) {
      errors.push(err);
      continue;
    }

    const phone = normalizePhone(raw.telefone!);
    if (!phone) {
      errors.push({ row: rowNumber, motivo: "Telefone inválido" });
      continue;
    }

    const cpfHash = hashCPF(raw.cpf!, tenant.cpfSalt);
    const cpfMasked = maskCPF(raw.cpf!);
    const limiteTotal = parseNumber(raw.limite_total);
    const valorUtilizado = parseNumber(raw.valor_utilizado);
    const { percentual, faixa } = computeUsage(limiteTotal, valorUtilizado);

    const incoming: IncomingClientRow = {
      externalId: raw.id_cliente,
      nome: raw.nome!.trim(),
      telefone: phone,
      cpfHash,
      cpfMasked,
      cidade: raw.cidade?.trim(),
      dataCadastro: parseDate(raw.data_cadastro),
      dataAberturaConta: parseDate(raw.data_abertura_conta),
      limiteTotal,
      valorUtilizado,
      saldoDisponivel: parseNumber(raw.saldo_disponivel),
      valorAntecipado: parseNumber(raw.valor_antecipado),
      dataUltimaUtilizacao: parseDate(raw.data_ultima_utilizacao),
      statusConta: parseStatus(raw.status_conta),
      origemCliente: raw.origem_cliente?.trim(),
      autorizacaoComunicacao: parseBool(raw.autorizacao_comunicacao),
    };

    try {
      const existing = await findExistingClient(prisma, tenantId, incoming);

      const data = {
        externalId: incoming.externalId,
        nome: incoming.nome,
        telefone: incoming.telefone,
        cpfHash: incoming.cpfHash,
        cpfMasked: incoming.cpfMasked,
        cidade: incoming.cidade,
        dataCadastro: incoming.dataCadastro,
        dataAberturaConta: incoming.dataAberturaConta,
        limiteTotal: incoming.limiteTotal,
        valorUtilizado: incoming.valorUtilizado,
        saldoDisponivel: incoming.saldoDisponivel,
        valorAntecipado: incoming.valorAntecipado,
        dataUltimaUtilizacao: incoming.dataUltimaUtilizacao,
        percentualUtilizado: percentual,
        faixaUso: faixa,
        statusConta: incoming.statusConta,
        origemCliente: incoming.origemCliente,
        // opt-out é sticky: uma vez recusado, importação nunca reativa a autorização sozinha
        autorizacaoComunicacao: existing?.optOutAt ? false : incoming.autorizacaoComunicacao,
        lastImportJobId: job.id,
        tenantId,
      };

      if (existing) {
        await prisma.client.update({ where: { id: existing.id }, data });
        updated++;
      } else {
        await prisma.client.create({ data });
        added++;
      }
    } catch (e: any) {
      errors.push({ row: rowNumber, motivo: `Erro ao gravar registro: ${e.message}` });
    }
  }

  const status = errors.length === 0 ? "CONCLUIDO" : errors.length === rows.length ? "FALHOU" : "CONCLUIDO_COM_ERROS";

  await prisma.importJob.update({
    where: { id: job.id },
    data: {
      status,
      addedCount: added,
      updatedCount: updated,
      errorCount: errors.length,
      errors: errors as any,
      finishedAt: new Date(),
    },
  });

  return {
    importJobId: job.id,
    result: { totalRows: rows.length, addedCount: added, updatedCount: updated, errorCount: errors.length, errors },
  };
}

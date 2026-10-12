import { AppPrismaClient } from "../config/db";
import { computeUsage } from "./usage";
import { digitsOnly, hashCPF, isValidCPF, maskCPF, normalizePhone } from "./masking";
import { findExistingClient, IncomingClientRow } from "./dedupe";
import { notify } from "./notifications";
import { snapshotBefore } from "./cardAccountImport";

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
  // Algumas planilhas exportam valores já formatados como moeda (ex.: "R$ 500,00", "R$ -" pra
  // zero) — remove o símbolo antes de converter, e trata "-" isolado como zero.
  const s = String(v).trim().replace(/^R\$\s*/i, "").trim();
  if (s === "-" || s === "") return 0;
  const n = Number(s.replace(/\./g, "").replace(",", "."));
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

export interface ImportOptions {
  /** campos (chaves de RawSheetRow) que o ARQUIVO INTEIRO traz com algum valor; sem isso vale o que este lote traz */
  camposPresentes?: string[];
  loteId?: string;
  nomeArquivo?: string;
}

/** Campos que, quando o arquivo não os traz, NÃO podem ser zerados em clientes que já existem. */
const PROTEGIDOS: Record<string, (keyof RawSheetRow)[]> = {
  limiteTotal: ["limite_total"],
  valorUtilizado: ["valor_utilizado"],
  saldoDisponivel: ["saldo_disponivel"],
  valorAntecipado: ["valor_antecipado"],
  statusConta: ["status_conta"],
  autorizacaoComunicacao: ["autorizacao_comunicacao"],
};

/**
 * Executa a importação de um lote de linhas já lidas da planilha (ou CSV).
 * Aplica: validação de campos obrigatórios + checksum de CPF, normalização de
 * telefone, hash/máscara de CPF, deduplicação (última atualização ganha),
 * cálculo de percentual_utilizado e faixa de uso.
 */
export async function runImport(
  prisma: AppPrismaClient,
  tenantId: string,
  rows: RawSheetRow[],
  triggeredBy: string,
  source: "google_sheets" | "csv" = "google_sheets",
  sheetId?: string,
  opts: ImportOptions = {}
): Promise<{ importJobId: string; result: ImportRunResult }> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });

  const job = await prisma.importJob.create({
    data: {
      tenantId,
      source,
      sheetId,
      formato: source === "google_sheets" ? "google_sheets" : "generico",
      loteId: opts.loteId,
      nomeArquivo: opts.nomeArquivo,
      status: "EM_EXECUCAO",
      totalRows: rows.length,
      triggeredBy,
    },
  });

  // Proteção: uma coluna que o arquivo não traz (ou vazia em todas as linhas) não zera clientes existentes.
  const presentes = new Set<string>(
    opts.camposPresentes ?? (Object.values(PROTEGIDOS).flat() as string[]).filter((k) => rows.some((r) => (r as any)[k] !== undefined && (r as any)[k] !== null && String((r as any)[k]).trim() !== ""))
  );
  const changes: { clientId: string; kind: "ATUALIZADO" | "CRIADO"; before: Record<string, unknown> | null }[] = [];

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
        const update: Record<string, unknown> = { ...data };
        delete update.tenantId;
        for (const [coluna, campos] of Object.entries(PROTEGIDOS)) {
          if (!campos.some((c) => presentes.has(c))) delete update[coluna];
        }
        // percentual/faixa: recalcula com o que o arquivo traz e o que já estava, ou deixa como está
        if (presentes.has("limite_total") || presentes.has("valor_utilizado")) {
          const lim = presentes.has("limite_total") ? incoming.limiteTotal : Number(existing.limiteTotal);
          const util = presentes.has("valor_utilizado") ? incoming.valorUtilizado : Number(existing.valorUtilizado);
          const u = computeUsage(lim, util);
          update.percentualUtilizado = u.percentual;
          update.faixaUso = u.faixa;
        } else {
          delete update.percentualUtilizado;
          delete update.faixaUso;
        }
        if (existing.optOutAt && "autorizacaoComunicacao" in update) update.autorizacaoComunicacao = false;
        changes.push({ clientId: existing.id, kind: "ATUALIZADO", before: snapshotBefore(existing as any, update as any) });
        await prisma.client.update({ where: { id: existing.id }, data: update });
        // Detecta renovação de limite (aumento de limiteTotal) para alimentar a automação
        // LIMITE_RENOVADO — não há campo de histórico de limite dedicado, então o próprio
        // aumento observado entre importações é registrado como Movement.
        if (presentes.has("limite_total") && incoming.limiteTotal > Number(existing.limiteTotal)) {
          await prisma.movement.create({
            data: {
              clientId: existing.id,
              tipo: "renovacao_limite",
              valor: incoming.limiteTotal - Number(existing.limiteTotal),
              data: new Date(),
            },
          });
        }
        updated++;
      } else {
        const created = await prisma.client.create({ data, select: { id: true } });
        changes.push({ clientId: created.id, kind: "CRIADO", before: null });
        added++;
      }
    } catch (e: any) {
      errors.push({ row: rowNumber, motivo: `Erro ao gravar registro: ${e.message}` });
    }
  }

  // Estado anterior dos clientes tocados, para poder desfazer o lote (falha aqui não derruba a importação).
  try {
    for (let i = 0; i < changes.length; i += 500) {
      await prisma.importChange.createMany({
        data: changes.slice(i, i + 500).map((c) => ({ tenantId, importJobId: job.id, loteId: opts.loteId ?? null, clientId: c.clientId, kind: c.kind, before: (c.before ?? undefined) as any })),
      });
    }
  } catch (e) {
    console.error("[importService] não guardei o estado anterior (sem 'Desfazer' neste lote):", (e as Error).message);
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

  // Notificação operacional (Fase 2): alerta quando a sincronização falha totalmente ou
  // termina com erros, para que o operador saiba corrigir a planilha sem precisar checar o
  // histórico de importações proativamente.
  if (status === "FALHOU") {
    await notify(prisma, {
      tenantId,
      type: "IMPORT_FAILED",
      severity: "ERRO",
      message: `Sincronização (${source}) falhou: todas as ${rows.length} linhas tiveram erro de validação.`,
      relatedType: "ImportJob",
      relatedId: job.id,
    });
  } else if (status === "CONCLUIDO_COM_ERROS") {
    await notify(prisma, {
      tenantId,
      type: "IMPORT_PARTIAL_ERRORS",
      severity: "AVISO",
      message: `Sincronização (${source}) concluída com ${errors.length} linha(s) com erro de ${rows.length} processadas.`,
      relatedType: "ImportJob",
      relatedId: job.id,
    });
  }

  return {
    importJobId: job.id,
    result: { totalRows: rows.length, addedCount: added, updatedCount: updated, errorCount: errors.length, errors },
  };
}

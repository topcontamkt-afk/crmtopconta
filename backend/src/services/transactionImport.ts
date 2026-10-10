import { AppPrismaClient } from "../config/db";
import { hashDocument, isValidDocument } from "./masking";
import { notify } from "./notifications";
import { ImportRunResult } from "./importService";
import { classifyTransaction, parseBrDateTime, parseMoney, TransactionKind } from "./transactionClassifier";

/**
 * Importador do extrato de transações do cartão (uma linha por operação). As chaves já são o
 * vocabulário canônico do sistema; o mapeamento "cabeçalho da planilha -> campo canônico" é feito
 * no frontend (tela de upload, ver CARD_TRANSACTION_FIELDS em frontend/src/utils/importFields.ts).
 *
 * Dados do cliente (nome/telefone/e-mail) NÃO são importados daqui — o cadastro vem da base de
 * "Cartões e contas" e a ligação é pelo CPF/CNPJ (hash por tenant, nunca em claro). Isso evita
 * duas fontes divergentes para o mesmo dado pessoal.
 *
 * Regras (ver transactionClassifier.ts): só antecipação e compra contam como uso; assinatura e
 * descrições desconhecidas são guardadas mas ficam fora de conversão/retenção. Idempotente: a
 * mesma idTransacao reenviada é ignorada (transação é um fato imutável), então o extrato pode
 * ser reenviado com sobreposição de dias sem duplicar nada.
 */
export interface TransactionRow {
  id_transacao?: string; // "idTransacao"
  data_confirmada?: string; // "DtConfirmada" — dd/mm/aaaa hh:mm:ss, horário de Brasília
  documento?: string; // "CpfCnpjCliente"
  descricao?: string; // "Descricao"
  nome_fantasia?: string; // "NomeFantasia"
  razao_social?: string; // "razaoSocial" (promotora/associação do convênio)
  valor_parcela?: string | number; // total da operação (principal + juros)
  valor_principal?: string | number; // "ValorPrincipal" — valor movimentado
  juros?: string | number; // "Juros" — lucro da antecipação
}

export interface TransactionImportResult extends ImportRunResult {
  /** linhas válidas cuja idTransacao já existia (ou repetida no mesmo envio) — ignoradas */
  duplicateCount: number;
}

interface RowError {
  row: number;
  motivo: string;
}

const REQUIRED_FIELDS: (keyof TransactionRow)[] = ["id_transacao", "data_confirmada", "documento", "descricao"];

// Mesmo racional de cardAccountImport: lotes e concorrência limitados para não estourar o pool
// de conexões do Prisma nem o tempo da função serverless.
const INSERT_CHUNK = 500;
const LOOKUP_CHUNK = 1000;

const FUTURE_TOLERANCE_MS = 24 * 3600 * 1000;

export interface PreparedTransaction {
  rowNumber: number;
  externalId: string;
  cpfHash: string;
  confirmedAt: Date;
  descricao: string;
  nomeFantasia?: string;
  razaoSocial?: string;
  kind: TransactionKind;
  countsAsUsage: boolean;
  valorTotal: number;
  valorPrincipal: number;
  juros: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Valida e transforma uma linha crua (sem banco). Retorna o erro da linha, ou a linha pronta. */
export function prepareTransactionRow(
  raw: TransactionRow,
  rowNumber: number,
  tenantCpfSalt: string,
  now: Date = new Date()
): { error: RowError } | { prepared: PreparedTransaction } {
  const fail = (motivo: string) => ({ error: { row: rowNumber, motivo } });

  for (const field of REQUIRED_FIELDS) {
    if (!raw[field] || String(raw[field]).trim() === "") {
      return fail(`Campo obrigatório ausente: ${field}`);
    }
  }
  if (!isValidDocument(raw.documento!)) return fail("CPF/CNPJ inválido (checksum não confere)");

  const confirmedAt = parseBrDateTime(raw.data_confirmada);
  if (!confirmedAt) return fail(`Data de confirmação inválida: "${raw.data_confirmada}" (esperado dd/mm/aaaa hh:mm:ss)`);
  if (confirmedAt.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) return fail("Data de confirmação no futuro");

  const parcela = parseMoney(raw.valor_parcela);
  const principal = parseMoney(raw.valor_principal);
  const jurosParsed = parseMoney(raw.juros);
  if (raw.valor_parcela !== undefined && String(raw.valor_parcela).trim() !== "" && parcela === null) {
    return fail(`Valor inválido em valor_parcela: "${raw.valor_parcela}"`);
  }
  if (raw.valor_principal !== undefined && String(raw.valor_principal).trim() !== "" && principal === null) {
    return fail(`Valor inválido em valor_principal: "${raw.valor_principal}"`);
  }
  if (raw.juros !== undefined && String(raw.juros).trim() !== "" && jurosParsed === null) {
    return fail(`Valor inválido em juros: "${raw.juros}"`);
  }

  const hasParcela = raw.valor_parcela !== undefined && String(raw.valor_parcela).trim() !== "";
  const hasPrincipal = raw.valor_principal !== undefined && String(raw.valor_principal).trim() !== "";
  if (!hasParcela && !hasPrincipal) return fail("Campo obrigatório ausente: valor_parcela ou valor_principal");

  const juros = jurosParsed ?? 0;
  // O extrato traz os dois; se vier só um, o outro se deriva (total = principal + juros).
  const valorTotal = hasParcela ? parcela! : principal! + juros;
  const valorPrincipal = hasPrincipal ? principal! : valorTotal - juros;

  // O extrato não deveria ter estorno (confirmado com o cliente), mas um valor negativo ou
  // zerado seria contado como "uso" — melhor recusar a linha e avisar do que inflar conversão.
  if (valorTotal <= 0 || valorPrincipal <= 0 || juros < 0) {
    return fail("Valor zerado ou negativo (possível estorno) — linha ignorada");
  }

  const { kind, countsAsUsage } = classifyTransaction(raw.descricao!);

  return {
    prepared: {
      rowNumber,
      externalId: String(raw.id_transacao).trim(),
      cpfHash: hashDocument(raw.documento!, tenantCpfSalt),
      confirmedAt,
      descricao: String(raw.descricao).trim(),
      nomeFantasia: raw.nome_fantasia?.trim() || undefined,
      razaoSocial: raw.razao_social?.trim() || undefined,
      kind,
      countsAsUsage,
      valorTotal: round2(valorTotal),
      valorPrincipal: round2(valorPrincipal),
      juros: round2(juros),
    },
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Liga ao cliente as transações que chegaram antes do cadastro (clientId nulo): procura, por
 * cpfHash, quem já existe na base de contas. Chamado ao fim da importação de transações e da de
 * "Cartões e contas", então a ordem em que as duas planilhas chegam não importa.
 */
export async function relinkOrphanTransactions(prisma: AppPrismaClient, tenantId: string): Promise<number> {
  const orphanHashes = await prisma.transaction.groupBy({
    by: ["cpfHash"],
    where: { tenantId, clientId: null },
    take: 5000,
  });
  if (orphanHashes.length === 0) return 0;

  let linked = 0;
  for (const hashes of chunk(
    orphanHashes.map((o) => o.cpfHash),
    LOOKUP_CHUNK
  )) {
    const clients = await prisma.client.findMany({
      where: { tenantId, cpfHash: { in: hashes } },
      select: { id: true, cpfHash: true },
    });
    for (const c of clients) {
      const res = await prisma.transaction.updateMany({
        where: { tenantId, cpfHash: c.cpfHash, clientId: null },
        data: { clientId: c.id },
      });
      linked += res.count;
    }
  }
  return linked;
}

export async function runTransactionImport(
  prisma: AppPrismaClient,
  tenantId: string,
  rows: TransactionRow[],
  triggeredBy: string
): Promise<{ importJobId: string; result: TransactionImportResult }> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });

  const job = await prisma.importJob.create({
    data: { tenantId, source: "transacoes", status: "EM_EXECUCAO", totalRows: rows.length, triggeredBy },
  });

  const errors: RowError[] = [];

  // Fase 1: validação/transformação em memória.
  const prepared: PreparedTransaction[] = [];
  const seen = new Set<string>();
  let repeatedInFile = 0;
  rows.forEach((raw, i) => {
    const out = prepareTransactionRow(raw, i + 2, tenant.cpfSalt);
    if ("error" in out) {
      errors.push(out.error);
      return;
    }
    if (seen.has(out.prepared.externalId)) {
      repeatedInFile++;
      return;
    }
    seen.add(out.prepared.externalId);
    prepared.push(out.prepared);
  });

  // Descrições desconhecidas: um aviso por descrição distinta (não por linha) — fica no histórico
  // da importação para alguém classificar. Enquanto isso, ficam fora de conversão/retenção.
  const unknown = new Map<string, { first: number; count: number }>();
  for (const p of prepared) {
    if (p.kind !== "OUTRO") continue;
    const cur = unknown.get(p.descricao);
    if (cur) cur.count++;
    else unknown.set(p.descricao, { first: p.rowNumber, count: 1 });
  }
  for (const [descricao, { first, count }] of unknown) {
    errors.push({
      row: first,
      motivo: `Aviso: descrição "${descricao}" não reconhecida (${count} transação(ões)) — guardada, mas NÃO conta como uso`,
    });
  }

  // Fase 2: quem já existe na base de contas (uma consulta por lote de hashes, não por linha).
  const clientIdByHash = new Map<string, string>();
  const distinctHashes = [...new Set(prepared.map((p) => p.cpfHash))];
  for (const hashes of chunk(distinctHashes, LOOKUP_CHUNK)) {
    const clients = await prisma.client.findMany({
      where: { tenantId, cpfHash: { in: hashes } },
      select: { id: true, cpfHash: true },
    });
    for (const c of clients) clientIdByHash.set(c.cpfHash, c.id);
  }
  const unlinkedClients = distinctHashes.filter((h) => !clientIdByHash.has(h)).length;
  if (unlinkedClients > 0) {
    errors.push({
      row: 0,
      motivo: `Aviso: ${unlinkedClients} cliente(s) do extrato ainda não constam na base de contas — transações guardadas sem vínculo (sem cidade/convênio) e ligadas automaticamente quando o cliente for importado`,
    });
  }

  // Fase 3: grava. skipDuplicates = INSERT ... ON CONFLICT DO NOTHING no (tenantId, externalId),
  // atômico mesmo com dois envios simultâneos do mesmo extrato.
  let added = 0;
  for (const batch of chunk(prepared, INSERT_CHUNK)) {
    try {
      const res = await prisma.transaction.createMany({
        data: batch.map((p) => ({
          tenantId,
          clientId: clientIdByHash.get(p.cpfHash) ?? null,
          cpfHash: p.cpfHash,
          externalId: p.externalId,
          confirmedAt: p.confirmedAt,
          descricao: p.descricao,
          nomeFantasia: p.nomeFantasia,
          razaoSocial: p.razaoSocial,
          kind: p.kind,
          countsAsUsage: p.countsAsUsage,
          valorTotal: p.valorTotal,
          valorPrincipal: p.valorPrincipal,
          juros: p.juros,
          importJobId: job.id,
        })),
        skipDuplicates: true,
      });
      added += res.count;
    } catch (e: any) {
      errors.push({ row: batch[0].rowNumber, motivo: `Erro ao gravar lote de transações: ${e.message}` });
    }
  }

  const duplicateCount = repeatedInFile + (prepared.length - added);

  // Liga transações órfãs de importações anteriores aos clientes que já existem agora.
  try {
    await relinkOrphanTransactions(prisma, tenantId);
  } catch {
    // não derruba a importação: o relink é refeito na próxima importação
  }

  const hardErrors = errors.filter((e) => !e.motivo.startsWith("Aviso:"));
  const status =
    hardErrors.length === 0 ? "CONCLUIDO" : hardErrors.length === rows.length ? "FALHOU" : "CONCLUIDO_COM_ERROS";

  await prisma.importJob.update({
    where: { id: job.id },
    data: {
      status,
      addedCount: added,
      updatedCount: 0,
      errorCount: errors.length,
      errors: errors as any,
      finishedAt: new Date(),
    },
  });

  if (status === "FALHOU") {
    await notify(prisma, {
      tenantId,
      type: "IMPORT_FAILED",
      severity: "ERRO",
      message: `Importação de transações falhou: todas as ${rows.length} linhas tiveram erro de validação.`,
      relatedType: "ImportJob",
      relatedId: job.id,
    });
  } else if (status === "CONCLUIDO_COM_ERROS") {
    await notify(prisma, {
      tenantId,
      type: "IMPORT_PARTIAL_ERRORS",
      severity: "AVISO",
      message: `Importação de transações concluída com ${hardErrors.length} linha(s) com erro de ${rows.length} processadas.`,
      relatedType: "ImportJob",
      relatedId: job.id,
    });
  }

  return {
    importJobId: job.id,
    result: {
      totalRows: rows.length,
      addedCount: added,
      updatedCount: 0,
      errorCount: errors.length,
      errors,
      duplicateCount,
    },
  };
}

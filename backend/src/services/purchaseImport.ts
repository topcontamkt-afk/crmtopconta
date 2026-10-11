import { refreshUsageColumns } from "./usageRefresh";
import { AppPrismaClient, tenantRaw } from "../config/db";
import { hashDocument } from "./masking";
import { categorizeMerchant, normalizeMerchantName } from "./merchantCategories";
import { isCommercePurchase, isUsageType, normalizeDocumentDigits, parseMoney, parsePurchaseDate } from "./purchaseParsing";

/**
 * Importa a aba "Todas as Compras" (transações do cartão). As chaves abaixo são o vocabulário
 * canônico; o mapeamento "cabeçalho da planilha -> campo" é feito na tela de upload.
 *
 *  - O cliente é achado pelo hash do CPF/CNPJ (mesmo hash da base de clientes). Transação de um
 *    documento que ainda não está na base NÃO é gravada — vira "sem cliente" no resultado, e basta
 *    reimportar o arquivo depois de importar os clientes (idempotente por idTransacaoCartao).
 *  - Só "Compra à Vista..." tem lojista/categoria; saque, Pix, assinatura e débito de fatura entram
 *    sem lojista (servem para histórico e para a data da última utilização).
 *  - Reimportar o mesmo arquivo não duplica (externalId único por tenant).
 */
export interface PurchaseRow {
  id_transacao?: string;
  data?: string; // DtConfirmada
  documento?: string; // CpfCnpjCliente
  descricao?: string; // tipo da transação
  lojista?: string; // NomeFantasia
  valor_principal?: string | number;
  valor_parcela?: string | number;
  juros?: string | number;
  razao_social?: string;
}

interface RowError {
  row: number;
  motivo: string;
}

interface PreparedPurchase {
  rowNumber: number;
  externalId: string;
  occurredAt: Date;
  cpfHash: string;
  tipo: string;
  lojista: string | null;
  valorPrincipal: number;
  valorParcela: number | null;
  juros: number | null;
  razaoSocial: string | null;
}

export interface PurchaseImportResult {
  totalRows: number;
  importedCount: number; // compras novas gravadas
  duplicateCount: number; // já existiam (mesmo idTransacaoCartao)
  unmatchedRows: number; // transações de documentos que não estão na base de clientes
  unmatchedClients: number; // quantos documentos distintos
  merchantsCreated: number;
  errorCount: number;
  errors: RowError[];
}

const MAX_ERRORS_STORED = 200;

function clean(v: unknown): string {
  return v === null || v === undefined ? "" : String(v).trim();
}

export async function runPurchaseImport(
  prisma: AppPrismaClient,
  tenantId: string,
  rows: PurchaseRow[],
  triggeredBy: string
): Promise<{ importJobId: string; result: PurchaseImportResult }> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const job = await prisma.importJob.create({
    data: { tenantId, source: "compras", status: "EM_EXECUCAO", totalRows: rows.length, triggeredBy },
  });

  const errors: RowError[] = [];
  const prepared: PreparedPurchase[] = [];
  const seenIds = new Set<string>();

  // Fase 1 (sem banco): valida e transforma cada linha.
  rows.forEach((raw, i) => {
    const rowNumber = i + 2;
    const externalId = clean(raw.id_transacao);
    if (!externalId) return void errors.push({ row: rowNumber, motivo: "Campo obrigatório ausente: id_transacao" });
    if (seenIds.has(externalId)) return; // repetida dentro do próprio lote: ignora em silêncio
    const occurredAt = parsePurchaseDate(raw.data);
    if (!occurredAt) return void errors.push({ row: rowNumber, motivo: `Data inválida: "${clean(raw.data)}"` });
    const digits = normalizeDocumentDigits(raw.documento);
    if (!digits) return void errors.push({ row: rowNumber, motivo: "CPF/CNPJ ausente ou inválido" });
    const tipo = clean(raw.descricao);
    if (!tipo) return void errors.push({ row: rowNumber, motivo: "Campo obrigatório ausente: descricao" });
    const valorPrincipal = parseMoney(raw.valor_principal);
    if (valorPrincipal === null) return void errors.push({ row: rowNumber, motivo: `Valor inválido: "${clean(raw.valor_principal)}"` });
    const lojista = clean(raw.lojista) || null;
    if (isCommercePurchase(tipo) && !lojista) return void errors.push({ row: rowNumber, motivo: "Compra sem lojista (NomeFantasia)" });

    seenIds.add(externalId);
    prepared.push({
      rowNumber,
      externalId,
      occurredAt,
      cpfHash: hashDocument(digits, tenant.cpfSalt),
      tipo,
      lojista,
      valorPrincipal,
      valorParcela: parseMoney(raw.valor_parcela),
      juros: parseMoney(raw.juros),
      razaoSocial: clean(raw.razao_social) || null,
    });
  });

  // Fase 2: clientes (uma consulta para o lote inteiro).
  const clientByHash = new Map<string, string>();
  if (prepared.length > 0) {
    const hashes = Array.from(new Set(prepared.map((p) => p.cpfHash)));
    const clients = await prisma.client.findMany({
      where: { tenantId, cpfHash: { in: hashes } },
      select: { id: true, cpfHash: true },
    });
    for (const c of clients) clientByHash.set(c.cpfHash, c.id);
  }
  const matched = prepared.filter((p) => clientByHash.has(p.cpfHash));
  const unmatched = prepared.filter((p) => !clientByHash.has(p.cpfHash));
  const unmatchedClients = new Set(unmatched.map((p) => p.cpfHash)).size;

  // Fase 3: lojistas (só de compras no comércio). Categoria automática para os novos; os que já
  // existem (inclusive os corrigidos à mão) não são tocados.
  const merchantNames = new Map<string, string>(); // nameKey -> nome
  for (const p of matched) {
    if (p.lojista && isCommercePurchase(p.tipo)) merchantNames.set(normalizeMerchantName(p.lojista), p.lojista);
  }
  const merchantIdByKey = new Map<string, string>();
  let merchantsCreated = 0;
  if (merchantNames.size > 0) {
    const keys = Array.from(merchantNames.keys());
    const existing = await prisma.merchant.findMany({ where: { tenantId, nameKey: { in: keys } }, select: { id: true, nameKey: true } });
    for (const m of existing) merchantIdByKey.set(m.nameKey, m.id);
    const missing = keys.filter((k) => !merchantIdByKey.has(k));
    if (missing.length > 0) {
      const created = await prisma.merchant.createMany({
        data: missing.map((k) => ({
          tenantId,
          name: merchantNames.get(k)!,
          nameKey: k,
          category: categorizeMerchant(merchantNames.get(k)!),
          categorySource: "AUTO",
        })),
        skipDuplicates: true,
      });
      merchantsCreated = created.count;
      const refetched = await prisma.merchant.findMany({ where: { tenantId, nameKey: { in: missing } }, select: { id: true, nameKey: true } });
      for (const m of refetched) merchantIdByKey.set(m.nameKey, m.id);
    }
  }

  // Fase 4: grava as compras (createMany + skipDuplicates: uma ida ao banco para o lote todo).
  let importedCount = 0;
  if (matched.length > 0) {
    const created = await prisma.purchase.createMany({
      data: matched.map((p) => ({
        tenantId,
        clientId: clientByHash.get(p.cpfHash)!,
        merchantId: p.lojista && isCommercePurchase(p.tipo) ? merchantIdByKey.get(normalizeMerchantName(p.lojista)) ?? null : null,
        externalId: p.externalId,
        occurredAt: p.occurredAt,
        tipo: p.tipo,
        merchantName: p.lojista,
        valorPrincipal: p.valorPrincipal,
        valorParcela: p.valorParcela,
        juros: p.juros,
        razaoSocial: p.razaoSocial,
        importJobId: job.id,
      })),
      skipDuplicates: true,
    });
    importedCount = created.count;
  }
  const duplicateCount = matched.length - importedCount;

  // Fase 5: data da última utilização do cliente = a mais recente entre compra/saque/Pix. Só avança
  // (nunca volta para uma data anterior), então reimportar planilha antiga não regride o dado.
  const lastUse = new Map<string, Date>();
  for (const p of matched) {
    if (!isUsageType(p.tipo)) continue;
    const clientId = clientByHash.get(p.cpfHash)!;
    const current = lastUse.get(clientId);
    if (!current || p.occurredAt > current) lastUse.set(clientId, p.occurredAt);
  }
  if (lastUse.size > 0) {
    await tenantRaw.execute(
      `UPDATE "Client" AS c SET "dataUltimaUtilizacao" = u.d
       FROM (SELECT unnest($2::text[]) AS id, unnest($3::timestamptz[]) AS d) AS u
       WHERE c.id = u.id AND c."tenantId" = $1
         AND (c."dataUltimaUtilizacao" IS NULL OR c."dataUltimaUtilizacao" < u.d)`,
      tenantId,
      Array.from(lastUse.keys()),
      Array.from(lastUse.values()).map((d) => d.toISOString())
    );
  }

  // Recalcula uso real/etapa (recorrência, dias sem uso). Falha aqui não derruba a importação.
  await refreshUsageColumns(tenantId).catch((e) => console.error('[purchaseImport] uso real:', e));

  const storedErrors: RowError[] = errors.slice(0, MAX_ERRORS_STORED);
  if (unmatched.length > 0) {
    storedErrors.unshift({
      row: 0,
      motivo: `Aviso: ${unmatched.length} transação(ões) de ${unmatchedClients} cliente(s) que ainda não estão na base foram ignoradas. Importe os clientes e reenvie este arquivo.`,
    });
  }

  const status = errors.length === 0 ? "CONCLUIDO" : errors.length === rows.length ? "FALHOU" : "CONCLUIDO_COM_ERROS";
  await prisma.importJob.update({
    where: { id: job.id },
    data: {
      status,
      addedCount: importedCount,
      updatedCount: duplicateCount,
      errorCount: errors.length + (unmatched.length > 0 ? 1 : 0),
      errors: storedErrors as any,
      finishedAt: new Date(),
    },
  });

  return {
    importJobId: job.id,
    result: {
      totalRows: rows.length,
      importedCount,
      duplicateCount,
      unmatchedRows: unmatched.length,
      unmatchedClients,
      merchantsCreated,
      errorCount: errors.length,
      errors: storedErrors,
    },
  };
}

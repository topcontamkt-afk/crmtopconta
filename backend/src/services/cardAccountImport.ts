import { PrismaClient } from "@prisma/client";
import { computeUsage } from "./usage";
import { hashDocument, isValidDocument, maskDocument, detectDocumentType, normalizePhone } from "./masking";
import { findExistingClient, IncomingClientRow } from "./dedupe";
import { notify } from "./notifications";
import { ImportRunResult } from "./importService";

/**
 * Importador para o formato real de "Cartões e contas" (cadastro/ativação de cartão,
 * frequentemente vinculado a convênio de folha de pagamento) — distinto do formato genérico
 * do PRD original (ver importService.ts / RawSheetRow). As chaves aqui já são o vocabulário
 * canônico do sistema; o mapeamento "cabeçalho da planilha → campo canônico" é feito no
 * frontend (tela de upload), que envia as linhas já traduzidas para este formato.
 */
export interface CardAccountRow {
  documento?: string; // CPF (11 dígitos) ou CNPJ (14 dígitos) — coluna "CpfCnpjCliente"
  nome?: string;
  telefone?: string;
  email?: string;
  cidade?: string;
  data_cadastro?: string; // "DtSolicCadastro"
  data_ativacao?: string; // "DtAtivacaoCartao"
  limite?: string | number;
  saldo_disponivel?: string | number;
  status_cartao?: string; // "STATUS": ATIVOU_CARTAO | PODE_TER_MAS_NAO_ATIVOU | NAO_PODE_TER
  bloqueado?: string | boolean; // "Bloqueado"
  encerrado?: string | boolean; // "Encerramento"
  motivo_encerramento?: string; // "Motivo"
  obs_encerramento?: string; // "ObsEncerramento"
  empresa_conveniada?: string; // "nomeFantasia"
  cidade_empresa_conveniada?: string; // "nomeCidadeEmpresaConveniada"
  vinculo_empregaticio?: string;
  status_validacao_cadastro?: string; // "StatusValidacaoCadastro"
}

interface RowError {
  row: number;
  motivo: string;
}

const REQUIRED_FIELDS: (keyof CardAccountRow)[] = ["documento", "nome", "telefone"];

// Vocabulário confirmado da coluna STATUS (2026-08-20, conversa com o cliente):
//  - ATIVOU_CARTAO: cartão ativado, conta em uso -> Ativo
//  - PODE_TER_MAS_NAO_ATIVOU: aprovado mas nunca ativou -> Inativo (público "sem uso")
//  - NAO_PODE_TER: reprovado (cadastro originado no comércio) -> Inativo, sem autorização de
//    comunicação (nunca houve contrato aceito) e origemCliente marcado como "comercio"
const STATUS_CARTAO_MAP: Record<string, "ATIVO" | "INATIVO"> = {
  ATIVOU_CARTAO: "ATIVO",
  PODE_TER_MAS_NAO_ATIVOU: "INATIVO",
  NAO_PODE_TER: "INATIVO",
};

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
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "sim" || s === "1" || s === "yes";
}

function validateRow(row: CardAccountRow, rowNumber: number): RowError | null {
  for (const field of REQUIRED_FIELDS) {
    if (!row[field] || String(row[field]).trim() === "") {
      return { row: rowNumber, motivo: `Campo obrigatório ausente: ${field}` };
    }
  }
  if (!isValidDocument(row.documento!)) {
    return { row: rowNumber, motivo: "CPF/CNPJ inválido (checksum não confere)" };
  }
  return null;
}

/**
 * Importa o lote já mapeado para o vocabulário canônico (ver CardAccountRow). Aplica: validação
 * de CPF/CNPJ, normalização de telefone, cálculo de valor utilizado (limite - saldo disponível),
 * mapeamento de STATUS -> Ativo/Inativo, Bloqueado/Encerramento sobrepondo o status, e
 * autorização de comunicação por padrão (base legal: aceite no contrato de abertura de conta),
 * exceto para cadastros reprovados (NAO_PODE_TER).
 */
export async function runCardAccountImport(
  prisma: PrismaClient,
  tenantId: string,
  rows: CardAccountRow[],
  triggeredBy: string
): Promise<{ importJobId: string; result: ImportRunResult }> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });

  const job = await prisma.importJob.create({
    data: { tenantId, source: "csv", status: "EM_EXECUCAO", totalRows: rows.length, triggeredBy },
  });

  const errors: RowError[] = [];
  let added = 0;
  let updated = 0;

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const rowNumber = i + 2; // linha 1 = cabeçalho
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

    const statusKey = (raw.status_cartao || "").trim().toUpperCase();
    const statusRecognized = statusKey in STATUS_CARTAO_MAP;
    if (statusKey && !statusRecognized) {
      // Não pula a linha — importa com um valor conservador (Inativo) e sinaliza pra revisão,
      // em vez de arriscar herdar um STATUS novo/desconhecido como Ativo silenciosamente.
      errors.push({ row: rowNumber, motivo: `Aviso: STATUS "${raw.status_cartao}" desconhecido — importado como Inativo` });
    }
    let statusConta: "ATIVO" | "INATIVO" | "BLOQUEADO" = statusRecognized ? STATUS_CARTAO_MAP[statusKey] : "INATIVO";

    const isReprovado = statusKey === "NAO_PODE_TER";
    const encerrado = parseBool(raw.encerrado);
    const bloqueado = parseBool(raw.bloqueado);
    if (encerrado) statusConta = "INATIVO";
    if (bloqueado) statusConta = "BLOQUEADO"; // trava independente, tem prioridade máxima

    const limiteTotal = parseNumber(raw.limite);
    const saldoDisponivel = parseNumber(raw.saldo_disponivel);
    const valorUtilizado = Math.max(0, limiteTotal - saldoDisponivel);
    const { percentual, faixa } = computeUsage(limiteTotal, valorUtilizado);

    const documentoTipo = detectDocumentType(raw.documento!);
    const cpfHash = hashDocument(raw.documento!, tenant.cpfSalt);
    const cpfMasked = maskDocument(raw.documento!);

    const incoming: IncomingClientRow = {
      nome: raw.nome!.trim(),
      telefone: phone,
      cpfHash,
      cpfMasked,
      cidade: raw.cidade?.trim(),
      dataCadastro: parseDate(raw.data_cadastro),
      dataAberturaConta: parseDate(raw.data_ativacao),
      limiteTotal,
      valorUtilizado,
      saldoDisponivel,
      valorAntecipado: 0,
      dataUltimaUtilizacao: raw.status_cartao === "ATIVOU_CARTAO" ? parseDate(raw.data_ativacao) : undefined,
      statusConta,
      origemCliente: isReprovado ? "comercio" : undefined,
      // Base legal: aceite no contrato/abertura de conta (confirmado com o cliente) — todo
      // cadastro aprovado é considerado autorizado por padrão; reprovados (NAO_PODE_TER) nunca
      // tiveram contrato aceito, então ficam sem autorização.
      autorizacaoComunicacao: !isReprovado,
    };

    try {
      const existing = await findExistingClient(prisma, tenantId, incoming);

      const data = {
        nome: incoming.nome,
        telefone: incoming.telefone,
        cpfHash: incoming.cpfHash,
        cpfMasked: incoming.cpfMasked,
        documentoTipo,
        email: raw.email?.trim() || undefined,
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
        empresaConveniada: raw.empresa_conveniada?.trim() || undefined,
        cidadeEmpresaConveniada: raw.cidade_empresa_conveniada?.trim() || undefined,
        vinculoEmpregaticio: raw.vinculo_empregaticio?.trim() || undefined,
        statusValidacaoCadastro: raw.status_validacao_cadastro?.trim() || undefined,
        encerradoEm: encerrado ? new Date() : undefined,
        motivoEncerramento: raw.motivo_encerramento?.trim() || undefined,
        obsEncerramento: raw.obs_encerramento?.trim() || undefined,
        // opt-out é sticky: uma vez recusado, importação nunca reativa a autorização sozinha
        autorizacaoComunicacao: existing?.optOutAt ? false : incoming.autorizacaoComunicacao,
        lastImportJobId: job.id,
        tenantId,
      };

      if (existing) {
        await prisma.client.update({ where: { id: existing.id }, data });
        if (incoming.limiteTotal > Number(existing.limiteTotal)) {
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
        await prisma.client.create({ data });
        added++;
      }
    } catch (e: any) {
      errors.push({ row: rowNumber, motivo: `Erro ao gravar registro: ${e.message}` });
    }
  }

  const hardErrors = errors.filter((e) => !e.motivo.startsWith("Aviso:"));
  const status =
    hardErrors.length === 0 ? "CONCLUIDO" : hardErrors.length === rows.length ? "FALHOU" : "CONCLUIDO_COM_ERROS";

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

  if (status === "FALHOU") {
    await notify(prisma, {
      tenantId,
      type: "IMPORT_FAILED",
      severity: "ERRO",
      message: `Importação (cartões e contas) falhou: todas as ${rows.length} linhas tiveram erro de validação.`,
      relatedType: "ImportJob",
      relatedId: job.id,
    });
  } else if (status === "CONCLUIDO_COM_ERROS") {
    await notify(prisma, {
      tenantId,
      type: "IMPORT_PARTIAL_ERRORS",
      severity: "AVISO",
      message: `Importação (cartões e contas) concluída com ${hardErrors.length} linha(s) com erro de ${rows.length} processadas.`,
      relatedType: "ImportJob",
      relatedId: job.id,
    });
  }

  return {
    importJobId: job.id,
    result: { totalRows: rows.length, addedCount: added, updatedCount: updated, errorCount: errors.length, errors },
  };
}

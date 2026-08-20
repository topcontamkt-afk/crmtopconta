import { PrismaClient } from "@prisma/client";
import { computeUsage } from "./usage";
import { hashDocument, isValidDocument, maskDocument, detectDocumentType, normalizePhone } from "./masking";
import { findExistingClient, IncomingClientRow } from "./dedupe";
import { notify } from "./notifications";
import { ImportRunResult } from "./importService";

/**
 * Importador para o formato real de "Cartões e contas" — cadastro/ativação de cartão vinculado
 * a convênio de folha de pagamento, distinto do formato genérico do PRD original (ver
 * importService.ts / RawSheetRow). As chaves aqui já são o vocabulário canônico do sistema; o
 * mapeamento "cabeçalho da planilha → campo canônico" é feito no frontend (tela de upload).
 *
 * Duas fontes reais confirmadas com o cliente coexistem nesta interface, porque cada planilha
 * real traz um subconjunto diferente de sinais de status:
 *  - "Cartões e contas": STATUS explícito (ATIVOU_CARTAO/PODE_TER_MAS_NAO_ATIVOU/NAO_PODE_TER),
 *    Bloqueado, Encerramento, empresa/cidade conveniada, vínculo empregatício.
 *  - "SaldoCartao" (fonte mais completa, usada como principal por decisão do cliente em
 *    2026-08-20): sem STATUS explícito — o status é inferido de StatusCadastro (aprovação) +
 *    se já houve uso do saldo —, mas traz saldo utilizado direto (sem precisar calcular),
 *    razão social, lotação, dados de RH (salário, nascimento, sexo) e dois flags de bloqueio
 *    (CartaoBloqueado/ContaBloqueada, tratados como equivalentes por decisão do cliente).
 */
export interface CardAccountRow {
  documento?: string; // CPF (11 dígitos) ou CNPJ (14 dígitos) — coluna "CpfCnpjCliente"
  nome?: string;
  telefone?: string;
  email?: string;
  cidade?: string;
  razao_social?: string; // "razaoSocial" — razão social da promotora/associação
  id_cartao?: string; // "idCartao" — vira externalId
  lotacao?: string; // "Lotação" — departamento/unidade de trabalho do titular

  data_cadastro?: string; // "DtSolicCadastro"
  data_ativacao?: string; // "DtAtivacaoCartao"
  data_validade_cartao?: string; // "DataValidade"
  data_nascimento?: string; // "DataNascimento"
  sexo?: string;

  limite?: string | number; // "LimiteDeCompras" / "limite_total"
  saldo_disponivel?: string | number;
  valor_utilizado?: string | number; // "SaldoUtilizado" — quando vem pronto da planilha, usa direto
  bonus?: string | number;
  saldo_liquido_saque?: string | number;
  remuneracao_bruta?: string | number;
  remuneracao_liquida?: string | number;

  status_cartao?: string; // "STATUS": ATIVOU_CARTAO | PODE_TER_MAS_NAO_ATIVOU | NAO_PODE_TER
  status_cadastro?: string; // "StatusCadastro" (ex.: "APROVADO") — eixo de aprovação, sem lifecycle de ativação
  bloqueado?: string | boolean; // "Bloqueado" (formato antigo)
  cartao_bloqueado?: string | boolean; // "CartaoBloqueado"
  conta_bloqueada?: string | boolean; // "ContaBloqueada"
  encerrado?: string | boolean; // "Encerramento"
  motivo_encerramento?: string; // "Motivo"
  obs_encerramento?: string; // "ObsEncerramento"

  empresa_conveniada?: string; // "nomeFantasia" (formato antigo)
  cidade_empresa_conveniada?: string; // "nomeCidadeEmpresaConveniada" (formato antigo)
  vinculo_empregaticio?: string;
}

interface RowError {
  row: number;
  motivo: string;
}

const REQUIRED_FIELDS: (keyof CardAccountRow)[] = ["documento", "nome", "telefone"];

// Vocabulário confirmado da coluna STATUS da planilha "Cartões e contas" (2026-08-20):
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

function parseNumber(v?: string | number): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number") return v;
  const n = Number(String(v).replace(/\./g, "").replace(",", "."));
  return isNaN(n) ? undefined : n;
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
 * de CPF/CNPJ, normalização de telefone, determinação de status/autorização a partir do sinal
 * disponível (STATUS explícito OU StatusCadastro + uso do saldo), Bloqueado/Encerramento
 * sobrepondo o status com prioridade máxima, e autorização de comunicação por padrão (base
 * legal: aceite no contrato de abertura de conta) exceto para cadastros reprovados.
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

    const limiteTotal = parseNumber(raw.limite) ?? 0;
    const saldoDisponivel = parseNumber(raw.saldo_disponivel) ?? 0;
    // "SaldoCartao" já traz o valor utilizado pronto; formatos sem essa coluna (ex.: "Cartões e
    // contas") calculam como limite - saldo disponível.
    const valorUtilizado = parseNumber(raw.valor_utilizado) ?? Math.max(0, limiteTotal - saldoDisponivel);

    const statusCartaoKey = (raw.status_cartao || "").trim().toUpperCase();
    const statusCartaoRecognized = statusCartaoKey in STATUS_CARTAO_MAP;
    const statusCadastroKey = (raw.status_cadastro || "").trim().toUpperCase();

    let statusConta: "ATIVO" | "INATIVO" | "BLOQUEADO";
    let isReprovado = false;

    if (statusCartaoKey && statusCartaoRecognized) {
      statusConta = STATUS_CARTAO_MAP[statusCartaoKey];
      isReprovado = statusCartaoKey === "NAO_PODE_TER";
    } else if (statusCartaoKey) {
      // STATUS presente mas desconhecido — não descarta a linha, importa conservador e sinaliza.
      errors.push({ row: rowNumber, motivo: `Aviso: STATUS "${raw.status_cartao}" desconhecido — importado como Inativo` });
      statusConta = "INATIVO";
      isReprovado = true;
    } else if (statusCadastroKey === "APROVADO") {
      statusConta = valorUtilizado > 0 ? "ATIVO" : "INATIVO";
    } else if (statusCadastroKey) {
      // StatusCadastro presente mas não é "APROVADO" — trata como reprovado/pendente até
      // sabermos o vocabulário completo, e sinaliza pra revisão.
      errors.push({ row: rowNumber, motivo: `Aviso: StatusCadastro "${raw.status_cadastro}" desconhecido — importado como Inativo` });
      statusConta = "INATIVO";
      isReprovado = true;
    } else {
      // Nenhum sinal de status na planilha — conservador, sem sinalizar (campo simplesmente ausente).
      statusConta = "INATIVO";
    }

    const encerrado = parseBool(raw.encerrado);
    // CartaoBloqueado e ContaBloqueada tratados como equivalentes (decisão do cliente,
    // 2026-08-20) — qualquer um dos três sinais de bloqueio já basta.
    const bloqueado = parseBool(raw.bloqueado) || parseBool(raw.cartao_bloqueado) || parseBool(raw.conta_bloqueada);
    if (encerrado) statusConta = "INATIVO";
    if (bloqueado) statusConta = "BLOQUEADO"; // trava independente, tem prioridade máxima

    const { percentual, faixa } = computeUsage(limiteTotal, valorUtilizado);

    const documentoTipo = detectDocumentType(raw.documento!);
    const cpfHash = hashDocument(raw.documento!, tenant.cpfSalt);
    const cpfMasked = maskDocument(raw.documento!);

    const incoming: IncomingClientRow = {
      externalId: raw.id_cartao?.trim() || undefined,
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
      dataUltimaUtilizacao: statusConta === "ATIVO" ? parseDate(raw.data_ativacao) : undefined,
      statusConta,
      origemCliente: isReprovado ? "comercio" : undefined,
      // Base legal: aceite no contrato/abertura de conta (confirmado com o cliente) — todo
      // cadastro aprovado é considerado autorizado por padrão; reprovados nunca tiveram
      // contrato aceito, então ficam sem autorização.
      autorizacaoComunicacao: !isReprovado,
    };

    try {
      const existing = await findExistingClient(prisma, tenantId, incoming);

      const data = {
        externalId: incoming.externalId,
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
        statusValidacaoCadastro: raw.status_cadastro?.trim() || undefined,
        encerradoEm: encerrado ? new Date() : undefined,
        motivoEncerramento: raw.motivo_encerramento?.trim() || undefined,
        obsEncerramento: raw.obs_encerramento?.trim() || undefined,
        razaoSocial: raw.razao_social?.trim() || undefined,
        lotacao: raw.lotacao?.trim() || undefined,
        dataValidadeCartao: parseDate(raw.data_validade_cartao),
        dataNascimento: parseDate(raw.data_nascimento),
        sexo: raw.sexo?.trim() || undefined,
        remuneracaoBruta: parseNumber(raw.remuneracao_bruta),
        remuneracaoLiquida: parseNumber(raw.remuneracao_liquida),
        bonus: parseNumber(raw.bonus),
        saldoLiquidoSaque: parseNumber(raw.saldo_liquido_saque),
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

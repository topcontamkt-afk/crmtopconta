import { Prisma } from "@prisma/client";
import { AppPrismaClient } from "../config/db";
import { computeUsage } from "./usage";
import { hashDocument, isValidDocument, maskDocument, detectDocumentType, normalizePhone } from "./masking";
import { notify } from "./notifications";
import { ImportRunResult } from "./importService";
import { recordAccountSnapshots, SnapshotCandidate } from "./accountSnapshot";
import { normalizeDocumentDigits, parseMoney } from "./purchaseParsing";
import { decidirSupressao, liberarEliminacao, preservarCorrecoes, supressaoDaImportacao } from "./dedupe";

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
 *
 * Desempenho (2026-08-20): a versão original fazia 2-3 idas ao banco por linha, uma linha de
 * cada vez (achar existente, depois criar/atualizar) — uma planilha de milhares de linhas
 * levava minutos. Esta versão faz 1 consulta em lote pra achar quem já existe (por CPF/CNPJ),
 * e depois grava várias linhas em paralelo com `upsert` (uma ida ao banco por linha, e a
 * decisão criar-ou-atualizar fica atômica no Postgres via INSERT ... ON CONFLICT). Isso troca o
 * fallback de dedupe por telefone (usado no formato genérico, para planilhas sem um identificador
 * estável) por dedupe só por CPF/CNPJ — aceitável aqui porque, neste formato, o documento É o
 * identificador estável confirmado com o cliente; o telefone muda com mais frequência.
 */
export interface CardAccountRow {
  documento?: string; // CPF (11 dígitos) ou CNPJ (14 dígitos) — coluna "CpfCnpjCliente"
  nome?: string;
  telefone?: string;
  cidade?: string;
  id_cartao?: string; // "idCartao" — vira externalId
  // LGPD 01-01 (decisão 3 da triagem): e-mail, razão social, lotação, bônus, saldo líquido para saque, vínculo,
  // cidade da conveniada, motivo/observação do encerramento e status de validação NÃO são mais gravados
  // (nenhuma tela, segmento ou template os usa). Coluna que vier com esses nomes é ignorada.

  data_cadastro?: string; // "DtSolicCadastro"
  data_ativacao?: string; // "DtAtivacaoCartao"
  data_validade_cartao?: string; // "DataValidade"
  data_nascimento?: string; // "DataNascimento"
  sexo?: string;

  limite?: string | number; // "LimiteDeCompras" / "limite_total"
  saldo_disponivel?: string | number;
  valor_utilizado?: string | number; // "SaldoUtilizado" — quando vem pronto da planilha, usa direto
  remuneracao_bruta?: string | number;
  remuneracao_liquida?: string | number;

  status_cartao?: string; // "STATUS": ATIVOU_CARTAO | PODE_TER_MAS_NAO_ATIVOU | NAO_PODE_TER
  status_cadastro?: string; // "StatusCadastro" (ex.: "APROVADO") — só lido para inferir o status, não é gravado
  bloqueado?: string | boolean; // "Bloqueado" (formato antigo)
  cartao_bloqueado?: string | boolean; // "CartaoBloqueado"
  conta_bloqueada?: string | boolean; // "ContaBloqueada"
  encerrado?: string | boolean; // "Encerramento"

  empresa_conveniada?: string; // "nomeFantasia" (formato antigo)
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
// Também aceita status em texto simples ("Ativo", "Inativo", "Bloqueado", "Encerrado"), como vem
// em exportações de painéis de acompanhamento — sem marcar o cliente como reprovado.
const STATUS_CARTAO_MAP: Record<string, "ATIVO" | "INATIVO" | "BLOQUEADO"> = {
  ATIVOU_CARTAO: "ATIVO",
  PODE_TER_MAS_NAO_ATIVOU: "INATIVO",
  NAO_PODE_TER: "INATIVO",
  ATIVO: "ATIVO",
  INATIVO: "INATIVO",
  BLOQUEADO: "BLOQUEADO",
  ENCERRADO: "INATIVO",
};

// Concorrência limitada em vez de Promise.all irrestrito: grava várias linhas ao mesmo tempo
// (rápido), sem abrir mais consultas simultâneas do que o pool de conexões do Prisma suporta
// (ver connection_limit em config/db.ts) nem sobrecarregar o pooler do Supabase.
const CONCURRENCY = 8;

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function parseDate(v?: string): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d;
}

export function parseNumber(v?: string | number): number | undefined {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) return undefined;
  if (typeof v === "number") return v;
  // Aceita "R$ 500,00" (BR), "2,000.00" / "10.50" (EUA, comum em CSV exportado do Sheets) e
  // "R$ -" (zero): parseMoney deduz o separador decimal de cada valor em vez de assumir BR.
  return parseMoney(v) ?? undefined;
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

export interface PreparedRow {
  rowNumber: number;
  cpfHash: string;
  limiteTotal: number;
  saldoDisponivel: number;
  valorUtilizado: number;
  statusConta: "ATIVO" | "INATIVO" | "BLOQUEADO";
  data: Prisma.ClientCreateInput;
}

/** Fase 1 (sem banco): valida e transforma cada linha crua no formato de gravação. */
function prepareRow(rawIn: CardAccountRow, rowNumber: number, tenantCpfSalt: string, jobId: string, tenantId: string, errors: RowError[]): PreparedRow | null {
  // Planilhas perdem o zero à esquerda do CPF/CNPJ (ex.: CPF com 10 dígitos): recompõe antes de validar.
  const doc = rawIn.documento ? normalizeDocumentDigits(rawIn.documento) : null;
  const raw: CardAccountRow = doc ? { ...rawIn, documento: doc } : rawIn;
  const err = validateRow(raw, rowNumber);
  if (err) {
    errors.push(err);
    return null;
  }

  const phone = normalizePhone(raw.telefone!);
  if (!phone) {
    errors.push({ row: rowNumber, motivo: "Telefone inválido" });
    return null;
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
    errors.push({ row: rowNumber, motivo: `Aviso: STATUS "${raw.status_cartao}" desconhecido — importado como Inativo` });
    statusConta = "INATIVO";
    isReprovado = true;
  } else if (statusCadastroKey === "APROVADO") {
    statusConta = valorUtilizado > 0 ? "ATIVO" : "INATIVO";
  } else if (statusCadastroKey) {
    errors.push({ row: rowNumber, motivo: `Aviso: StatusCadastro "${raw.status_cadastro}" desconhecido — importado como Inativo` });
    statusConta = "INATIVO";
    isReprovado = true;
  } else {
    statusConta = "INATIVO";
  }

  const encerrado = parseBool(raw.encerrado);
  const bloqueado = parseBool(raw.bloqueado) || parseBool(raw.cartao_bloqueado) || parseBool(raw.conta_bloqueada);
  if (encerrado) statusConta = "INATIVO";
  if (bloqueado) statusConta = "BLOQUEADO"; // trava independente, tem prioridade máxima

  const { percentual, faixa } = computeUsage(limiteTotal, valorUtilizado);

  const documentoTipo = detectDocumentType(raw.documento!);
  const cpfHash = hashDocument(raw.documento!, tenantCpfSalt);
  const cpfMasked = maskDocument(raw.documento!);

  const data: Prisma.ClientCreateInput = {
    tenant: { connect: { id: tenantId } },
    externalId: raw.id_cartao?.trim() || undefined,
    nome: raw.nome!.trim(),
    telefone: phone,
    cpfHash,
    cpfMasked,
    documentoTipo,
    cidade: raw.cidade?.trim(),
    dataCadastro: parseDate(raw.data_cadastro),
    dataAberturaConta: parseDate(raw.data_ativacao),
    limiteTotal,
    valorUtilizado,
    saldoDisponivel,
    valorAntecipado: 0,
    dataUltimaUtilizacao: statusConta === "ATIVO" ? parseDate(raw.data_ativacao) : undefined,
    percentualUtilizado: percentual,
    faixaUso: faixa,
    statusConta,
    origemCliente: isReprovado ? "comercio" : undefined,
    empresaConveniada: raw.empresa_conveniada?.trim() || undefined,
    // LGPD 04-06: data do PRIMEIRO encerramento visto (planUpdate não regrava em quem já tem)
    encerradoEm: encerrado ? new Date() : undefined,
    dataValidadeCartao: parseDate(raw.data_validade_cartao),
    dataNascimento: parseDate(raw.data_nascimento),
    sexo: raw.sexo?.trim() || undefined,
    remuneracaoBruta: parseNumber(raw.remuneracao_bruta),
    remuneracaoLiquida: parseNumber(raw.remuneracao_liquida),
    // Base legal: aceite no contrato/abertura de conta (confirmado com o cliente) — todo
    // cadastro aprovado é considerado autorizado por padrão; reprovados nunca tiveram contrato
    // aceito, então ficam sem autorização. Sobrescrito por optOutAt sticky mais abaixo, se
    // a linha já existir e tiver optado por sair. LGPD 04-06: conta encerrada sai de todo uso
    // comercial (todo público de campanha exige a autorização).
    autorizacaoComunicacao: !isReprovado && !encerrado,
    lastImportJobId: jobId,
  };

  return { rowNumber, cpfHash, limiteTotal, saldoDisponivel, valorUtilizado, statusConta, data };
}

/* ───────────────────────── proteção: o que a planilha realmente traz ───────────────────────── */

/**
 * Quais grupos de informação o ARQUIVO traz de verdade (ao menos uma célula preenchida). Uma coluna que
 * não existe, ou que está vazia em todas as linhas, NÃO altera clientes que já estão na base: foi assim
 * que uma planilha de compras importada como "Cartões e contas" zerou limite e saldo de milhares de
 * clientes. Coluna presente com célula vazia numa linha continua valendo zero (é como o comércio
 * credenciado, sem limite, aparece na planilha).
 */
export interface FieldPresence {
  limite: boolean;
  saldo: boolean;
  utilizado: boolean;
  status: boolean;
}

export const ALL_PRESENT: FieldPresence = { limite: true, saldo: true, utilizado: true, status: true };

const filled = (v: unknown) => v !== undefined && v !== null && String(v).trim() !== "";

export function detectPresence(rows: CardAccountRow[]): FieldPresence {
  return {
    limite: rows.some((r) => parseNumber(r.limite) !== undefined),
    saldo: rows.some((r) => parseNumber(r.saldo_disponivel) !== undefined),
    utilizado: rows.some((r) => parseNumber(r.valor_utilizado) !== undefined),
    status: rows.some((r) => [r.status_cartao, r.status_cadastro, r.bloqueado, r.cartao_bloqueado, r.conta_bloqueada, r.encerrado].some(filled)),
  };
}

/** Nomes legíveis do que o arquivo NÃO traz (e portanto não será alterado nos clientes existentes). */
export function ignoredFields(p: FieldPresence): string[] {
  const out: string[] = [];
  if (!p.limite) out.push("limite");
  if (!p.saldo) out.push("saldo disponível");
  if (!p.utilizado && !(p.limite && p.saldo)) out.push("valor utilizado");
  if (!p.status) out.push("status e autorização de comunicação");
  return out;
}

type ClientRow = Prisma.ClientGetPayload<Record<string, never>>;

export interface PlannedUpdate {
  /** só o que muda no cliente existente */
  update: Prisma.ClientUpdateInput;
  /** estado da conta DEPOIS da importação (para histórico e relatórios) */
  final: AccountStateLike;
}
interface AccountStateLike {
  limiteTotal: number;
  saldoDisponivel: number;
  valorUtilizado: number;
  statusConta: "ATIVO" | "INATIVO" | "BLOQUEADO";
}

/**
 * Atualização de um cliente que já existe, respeitando o que o arquivo traz (ver FieldPresence). O que o
 * arquivo não informa fica como está; `valorAntecipado` nunca é tocado (não vem desta planilha).
 */
export function planUpdate(p: PreparedRow, existing: ClientRow, presence: FieldPresence): PlannedUpdate {
  const update: Prisma.ClientUpdateInput = { ...p.data };
  delete (update as any).tenant;
  delete (update as any).valorAntecipado;

  const exLimite = Number(existing.limiteTotal);
  const exSaldo = Number(existing.saldoDisponivel);
  const exUtil = Number(existing.valorUtilizado);

  const temUtilizado = presence.utilizado || (presence.limite && presence.saldo);
  if (!presence.limite) delete update.limiteTotal;
  if (!presence.saldo) delete update.saldoDisponivel;
  if (!temUtilizado) delete update.valorUtilizado;

  const limite = presence.limite ? p.limiteTotal : exLimite;
  const saldo = presence.saldo ? p.saldoDisponivel : exSaldo;
  const util = temUtilizado ? p.valorUtilizado : exUtil;
  if (presence.limite || temUtilizado) {
    const { percentual, faixa } = computeUsage(limite, util);
    update.percentualUtilizado = percentual;
    update.faixaUso = faixa;
  } else {
    delete update.percentualUtilizado;
    delete update.faixaUso;
  }

  let status = existing.statusConta as AccountStateLike["statusConta"];
  if (presence.status) {
    status = p.statusConta;
  } else {
    delete update.statusConta;
    delete update.autorizacaoComunicacao;
    delete update.origemCliente;
    delete update.encerradoEm;
  }
  // LGPD 04-06: a data do encerramento é a do primeiro registro; reimportar não a regrava
  if (existing.encerradoEm) delete update.encerradoEm;
  // LGPD 03-01: a data de ativação da planilha nunca faz regredir o último uso já conhecido (ex.: o do extrato)
  const novoUso = update.dataUltimaUtilizacao as Date | undefined;
  if (novoUso && existing.dataUltimaUtilizacao && novoUso.getTime() <= existing.dataUltimaUtilizacao.getTime()) delete update.dataUltimaUtilizacao;
  // opt-out é sticky: nunca reativa a autorização sozinho (LGPD 02-02)
  if (existing.optOutAt && "autorizacaoComunicacao" in update) update.autorizacaoComunicacao = false;

  return { update, final: { limiteTotal: limite, saldoDisponivel: saldo, valorUtilizado: util, statusConta: status } };
}

/**
 * Colunas que a importação vai gravar no cliente, com o valor de ANTES (para desfazer). LGPD 01-02: só as que
 * de fato vão ser gravadas — chave com valor undefined (coluna que o arquivo não traz) o Prisma ignora no update,
 * então não entra aqui (antes ia o cadastro inteiro: renda, nascimento, sexo...).
 */
export function snapshotBefore(existing: ClientRow, update: Prisma.ClientUpdateInput): Record<string, unknown> {
  const before: Record<string, unknown> = {};
  for (const key of Object.keys(update)) {
    if ((update as Record<string, unknown>)[key] === undefined) continue;
    if (key in existing) before[key] = (existing as any)[key];
  }
  return JSON.parse(JSON.stringify(before));
}

export interface ChangeSummary {
  limiteAlterado: boolean;
  limiteZerado: boolean;
  limiteAumentou: boolean;
  limiteDiminuiu: boolean;
  saldoAlterado: boolean;
  statusAlterado: boolean;
  statusPara?: "ATIVO" | "INATIVO" | "BLOQUEADO";
  autorizacaoRevogada: boolean;
  autorizacaoConcedida: boolean;
  cadastroAlterado: boolean;
}

const cents = (n: number) => Math.round(n * 100);

/** O que muda de fato num cliente existente (para a prévia de impacto). */
export function summarizeChange(existing: ClientRow, planned: PlannedUpdate): ChangeSummary {
  const exLimite = Number(existing.limiteTotal);
  const novoAut = (planned.update as any).autorizacaoComunicacao as boolean | undefined;
  const nome = (planned.update as any).nome as string | undefined;
  const tel = (planned.update as any).telefone as string | undefined;
  return {
    limiteAlterado: cents(planned.final.limiteTotal) !== cents(exLimite),
    limiteZerado: exLimite > 0 && planned.final.limiteTotal === 0,
    limiteAumentou: planned.final.limiteTotal > exLimite,
    limiteDiminuiu: planned.final.limiteTotal < exLimite,
    saldoAlterado: cents(planned.final.saldoDisponivel) !== cents(Number(existing.saldoDisponivel)),
    statusAlterado: planned.final.statusConta !== existing.statusConta,
    statusPara: planned.final.statusConta !== existing.statusConta ? planned.final.statusConta : undefined,
    autorizacaoRevogada: novoAut === false && existing.autorizacaoComunicacao === true,
    autorizacaoConcedida: novoAut === true && existing.autorizacaoComunicacao === false,
    cadastroAlterado: (nome !== undefined && nome !== existing.nome) || (tel !== undefined && tel !== existing.telefone),
  };
}

export interface ImportPreview {
  total: number;
  invalidos: number;
  novos: number;
  atualizados: number;
  semAlteracao: number;
  limite: { alterados: number; zerados: number; aumentaram: number; diminuiram: number };
  saldoAlterados: number;
  status: { alterados: number; paraInativo: number; paraBloqueado: number; paraAtivo: number };
  autorizacao: { revogadas: number; concedidas: number };
  cadastroAlterados: number;
  /** o que o arquivo não traz e, por isso, não será alterado nos clientes existentes */
  ignorados: string[];
  /** até 5 clientes que perdem o limite, para conferir a olho */
  exemplosZerados: { nome: string; limiteAntes: number }[];
}

export const EMPTY_PREVIEW: ImportPreview = {
  total: 0, invalidos: 0, novos: 0, atualizados: 0, semAlteracao: 0,
  limite: { alterados: 0, zerados: 0, aumentaram: 0, diminuiram: 0 }, saldoAlterados: 0,
  status: { alterados: 0, paraInativo: 0, paraBloqueado: 0, paraAtivo: 0 }, autorizacao: { revogadas: 0, concedidas: 0 },
  cadastroAlterados: 0, ignorados: [], exemplosZerados: [],
};

async function fetchExisting(prisma: AppPrismaClient, tenantId: string, prepared: PreparedRow[]): Promise<Map<string, ClientRow>> {
  const map = new Map<string, ClientRow>();
  if (prepared.length === 0) return map;
  const existing = await prisma.client.findMany({ where: { tenantId, cpfHash: { in: [...new Set(prepared.map((p) => p.cpfHash))] } } });
  for (const c of existing) map.set(c.cpfHash, c);
  return map;
}

/**
 * Simula o lote SEM gravar nada: quantos clientes são novos/atualizados e o que muda neles (limite,
 * saldo, status, autorização). Alimenta a tela de confirmação antes de importar.
 */
export async function previewCardAccountImport(prisma: AppPrismaClient, tenantId: string, rows: CardAccountRow[], presence: FieldPresence = detectPresence(rows)): Promise<ImportPreview> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { cpfSalt: true } });
  const errors: RowError[] = [];
  const prepared: PreparedRow[] = [];
  rows.forEach((raw, i) => {
    const p = prepareRow(raw, i + 2, tenant.cpfSalt, "preview", tenantId, errors);
    if (p) prepared.push(p);
  });
  const existingByHash = await fetchExisting(prisma, tenantId, prepared);

  const out: ImportPreview = JSON.parse(JSON.stringify(EMPTY_PREVIEW));
  out.total = rows.length;
  out.invalidos = errors.filter((e) => !e.motivo.startsWith("Aviso:")).length;
  out.ignorados = ignoredFields(presence);
  for (const p of prepared) {
    const existing = existingByHash.get(p.cpfHash);
    if (!existing) {
      out.novos++;
      continue;
    }
    out.atualizados++;
    const c = summarizeChange(existing, planUpdate(p, existing, presence));
    if (c.limiteAlterado) out.limite.alterados++;
    if (c.limiteZerado) {
      out.limite.zerados++;
      if (out.exemplosZerados.length < 5) out.exemplosZerados.push({ nome: existing.nome, limiteAntes: Number(existing.limiteTotal) });
    }
    if (c.limiteAumentou) out.limite.aumentaram++;
    if (c.limiteDiminuiu) out.limite.diminuiram++;
    if (c.saldoAlterado) out.saldoAlterados++;
    if (c.statusAlterado) {
      out.status.alterados++;
      if (c.statusPara === "INATIVO") out.status.paraInativo++;
      if (c.statusPara === "BLOQUEADO") out.status.paraBloqueado++;
      if (c.statusPara === "ATIVO") out.status.paraAtivo++;
    }
    if (c.autorizacaoRevogada) out.autorizacao.revogadas++;
    if (c.autorizacaoConcedida) out.autorizacao.concedidas++;
    if (c.cadastroAlterado) out.cadastroAlterados++;
    if (!c.limiteAlterado && !c.saldoAlterado && !c.statusAlterado && !c.autorizacaoRevogada && !c.autorizacaoConcedida && !c.cadastroAlterado) out.semAlteracao++;
  }
  return out;
}

/** Avisos sem PII (só o número da linha vai junto) para linhas que a LGPD manda ignorar. */
// a supressão vem do pedido do titular ou da retenção automática: o aviso não presume qual
export const AVISO_ELIMINADO = "Aviso: dados do titular eliminados (pedido ou prazo de retenção, LGPD), linha ignorada";
export const AVISO_BLOQUEADO = "Aviso: titular com tratamento bloqueado (LGPD), linha ignorada";

export interface CardImportOptions {
  /** o que o ARQUIVO INTEIRO traz (a tela calcula no arquivo todo; sem isso vale o que este lote traz) */
  presence?: FieldPresence;
  loteId?: string;
  nomeArquivo?: string;
}

/**
 * Importa o lote já mapeado para o vocabulário canônico (ver CardAccountRow). Aplica: validação
 * de CPF/CNPJ, normalização de telefone, determinação de status/autorização a partir do sinal
 * disponível (STATUS explícito OU StatusCadastro + uso do saldo), Bloqueado/Encerramento
 * sobrepondo o status com prioridade máxima, e autorização de comunicação por padrão (base
 * legal: aceite no contrato de abertura de conta) exceto para cadastros reprovados.
 *
 * Proteções: o que o arquivo não traz não altera clientes existentes (planUpdate); o estado anterior
 * de cada cliente tocado vai para ImportChange, o que permite desfazer o lote (services/importUndo.ts).
 */
export async function runCardAccountImport(
  prisma: AppPrismaClient,
  tenantId: string,
  rows: CardAccountRow[],
  triggeredBy: string,
  opts: CardImportOptions = {}
): Promise<{ importJobId: string; result: ImportRunResult }> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const presence = opts.presence ?? detectPresence(rows);

  const job = await prisma.importJob.create({
    data: { tenantId, source: "csv", formato: "cartoes", loteId: opts.loteId, nomeArquivo: opts.nomeArquivo, status: "EM_EXECUCAO", totalRows: rows.length, triggeredBy },
  });
  // LGPD 04-04: a expiração do estado anterior (30 dias) agora é do job diário de retenção, para todos os formatos.

  const errors: RowError[] = [];

  // Fase 1: validação/transformação em memória, sem banco.
  const prepared: PreparedRow[] = [];
  rows.forEach((raw, i) => {
    const p = prepareRow(raw, i + 2, tenant.cpfSalt, job.id, tenantId, errors);
    if (p) prepared.push(p);
  });

  // Fase 2: uma única consulta pra descobrir quem já existe no lote inteiro (em vez de uma
  // consulta por linha) — dá pra saber criado-vs-atualizado e aplicar o opt-out sticky e o
  // registro de renovação de limite sem precisar reconsultar linha a linha.
  const existingByCpfHash = await fetchExisting(prisma, tenantId, prepared);
  // LGPD 03-01 / 02-02: supressão por documento (eliminação, bloqueio) e por telefone (opt-out), em lote
  const supressao = await supressaoDaImportacao(prisma, tenantId, prepared.map((p) => ({ telefone: p.data.telefone, cpfHash: p.cpfHash })));
  const correcaoVence = (tenant as { correcaoManualVence?: boolean }).correcaoManualVence !== false;
  const lgpd = { eliminadosAPedido: 0, bloqueadosLgpd: 0, supressoesLiberadas: 0, camposPreservadosCorrecao: 0, clientesComCorrecaoPreservada: 0 };
  const liberados = new Set<string>();

  // Fase 3: grava em paralelo (upsert — INSERT ... ON CONFLICT no Postgres, atômico mesmo com
  // documentos duplicados dentro do mesmo lote rodando ao mesmo tempo).
  let added = 0;
  let updated = 0;
  const movementsToCreate: { clientId: string; valor: number }[] = [];
  const snapshotCandidates: SnapshotCandidate[] = [];
  const changes = new Map<string, { clientId: string; kind: "ATUALIZADO" | "CRIADO"; before: Record<string, unknown> | null }>();

  await mapWithConcurrency(prepared, CONCURRENCY, async (p) => {
    const existing = existingByCpfHash.get(p.cpfHash);
    // LGPD 03-04: titular com tratamento suspenso não é atualizado pela planilha
    if (existing?.bloqueadoLgpdAt) {
      lgpd.bloqueadosLgpd++;
      errors.push({ row: p.rowNumber, motivo: AVISO_BLOQUEADO });
      return;
    }
    const dataRelacao = (p.data.dataAberturaConta as Date | undefined) ?? (p.data.dataCadastro as Date | undefined) ?? null;
    const decisao = decidirSupressao(supressao, { telefone: p.data.telefone, cpfHash: p.cpfHash, dataRelacao });
    if (decisao.acao === "IGNORAR") {
      if (decisao.motivo === "BLOQUEADO") lgpd.bloqueadosLgpd++;
      else lgpd.eliminadosAPedido++;
      // sem PII no resultado: só o número da linha
      errors.push({ row: p.rowNumber, motivo: decisao.motivo === "BLOQUEADO" ? AVISO_BLOQUEADO : AVISO_ELIMINADO });
      return;
    }
    if (decisao.liberarEliminacao && !liberados.has(p.cpfHash)) {
      // relação nova depois do pedido de eliminação: volta como cliente novo
      liberados.add(p.cpfHash);
      lgpd.supressoesLiberadas += await liberarEliminacao(prisma, tenantId, p.cpfHash, { motivo: "NOVA_RELACAO", origem: "importacao_cartoes", importJobId: job.id });
    }
    const semAutorizacao = decisao.semAutorizacao || !!existing?.optOutAt;
    const createData = {
      ...p.data,
      autorizacaoComunicacao: semAutorizacao ? false : p.data.autorizacaoComunicacao,
      ...(decisao.semAutorizacao && !existing ? { optOutAt: new Date() } : {}),
    };
    const planned = existing ? planUpdate(p, existing, presence) : null;
    if (planned && existing) {
      // LGPD 02-02: telefone/documento com opt-out (em qualquer cadastro) nunca é religado pela planilha
      if (decisao.semAutorizacao) {
        planned.update.autorizacaoComunicacao = false;
        if (!existing.optOutAt) planned.update.optOutAt = new Date();
      }
      // LGPD 03-03: correção manual vence a planilha
      if (correcaoVence) {
        const divergentes = preservarCorrecoes(planned.update as Record<string, unknown>, existing as unknown as Record<string, unknown>);
        if (divergentes.length) {
          lgpd.camposPreservadosCorrecao += divergentes.length;
          lgpd.clientesComCorrecaoPreservada++;
        }
      }
    }
    try {
      const saved = await prisma.client.upsert({
        where: { tenantId_cpfHash: { tenantId, cpfHash: p.cpfHash } },
        create: createData,
        update: planned ? planned.update : (createData as Prisma.ClientUpdateInput),
        select: { id: true },
      });
      const final = planned ? planned.final : { limiteTotal: p.limiteTotal, saldoDisponivel: p.saldoDisponivel, valorUtilizado: p.valorUtilizado, statusConta: p.statusConta };
      snapshotCandidates.push({
        clientId: saved.id,
        // estado de ANTES desta importação (lido na Fase 2) — undefined para cliente novo
        previous: existing
          ? { limiteTotal: Number(existing.limiteTotal), saldoDisponivel: Number(existing.saldoDisponivel), statusConta: existing.statusConta }
          : undefined,
        current: final,
      });
      if (existing && planned) {
        updated++;
        if (!changes.has(saved.id)) changes.set(saved.id, { clientId: saved.id, kind: "ATUALIZADO", before: snapshotBefore(existing, planned.update) });
        if (final.limiteTotal > Number(existing.limiteTotal)) {
          movementsToCreate.push({ clientId: existing.id, valor: final.limiteTotal - Number(existing.limiteTotal) });
        }
      } else {
        added++;
        if (!changes.has(saved.id)) changes.set(saved.id, { clientId: saved.id, kind: "CRIADO", before: null });
      }
    } catch (e: any) {
      errors.push({ row: p.rowNumber, motivo: `Erro ao gravar registro: ${e.message}` });
    }
  });

  // Estado anterior dos clientes tocados (para desfazer). Falha aqui não derruba a importação: só deixa de
  // haver "Desfazer" para este lote.
  try {
    const list = [...changes.values()];
    for (let i = 0; i < list.length; i += 500) {
      await prisma.importChange.createMany({
        data: list.slice(i, i + 500).map((c) => ({ tenantId, importJobId: job.id, loteId: opts.loteId ?? null, clientId: c.clientId, kind: c.kind, before: (c.before ?? undefined) as any })),
      });
    }
  } catch (e) {
    console.error("[cardAccountImport] não guardei o estado anterior (sem 'Desfazer' neste lote):", (e as Error).message);
  }

  // Renovações de limite (Movement) — não bloqueiam a resposta principal; erro aqui não deve
  // derrubar a importação em si, só fica sem o registro de automação LIMITE_RENOVADO.
  if (movementsToCreate.length > 0) {
    await prisma.movement
      .createMany({
        data: movementsToCreate.map((m) => ({ clientId: m.clientId, tipo: "renovacao_limite", valor: m.valor, data: new Date() })),
      })
      .catch(() => {});
  }

  // Histórico de saldo/limite/status (AccountSnapshot) — não derruba a importação se falhar.
  await recordAccountSnapshots(prisma, tenantId, snapshotCandidates, job.id);

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
    result: { totalRows: rows.length, addedCount: added, updatedCount: updated, errorCount: errors.length, errors, ...lgpd },
  };
}

import { AppPrismaClient } from "../config/db";
import { logAudit } from "../middleware/audit";
import { canonicalPhone, LoteSupressao, suprimidosEmLote } from "./privacy";

/**
 * Deduplicação por CPF (hash) e telefone.
 * Regra de fusão: "última atualização ganha" — o registro recém-importado
 * sobrescreve campos do existente, preservando o histórico (Movement, MessageEvent)
 * e o id interno do cliente já cadastrado.
 */

export interface IncomingClientRow {
  externalId?: string;
  nome: string;
  telefone: string;
  cpfHash: string;
  cpfMasked: string;
  cidade?: string;
  dataCadastro?: Date;
  dataAberturaConta?: Date;
  limiteTotal: number;
  valorUtilizado: number;
  saldoDisponivel: number;
  valorAntecipado: number;
  dataUltimaUtilizacao?: Date;
  statusConta?: "ATIVO" | "INATIVO" | "BLOQUEADO";
  origemCliente?: string;
  autorizacaoComunicacao: boolean;
}

export async function findExistingClient(
  prisma: AppPrismaClient,
  tenantId: string,
  row: IncomingClientRow
) {
  // Prioridade 1: CPF (chave forte, única por tenant)
  const byCpf = await prisma.client.findUnique({
    where: { tenantId_cpfHash: { tenantId, cpfHash: row.cpfHash } },
  });
  if (byCpf) return byCpf;

  // Prioridade 2: telefone (fallback quando CPF não bate, ex.: erro de digitação em importações antigas).
  // LGPD 03-01: nunca casa com cliente anonimizado (a linha não pode "reidentificar" um registro anonimizado).
  if (row.telefone) {
    const byPhone = await prisma.client.findFirst({
      where: { tenantId, telefone: row.telefone, anonymizedAt: null },
    });
    if (byPhone) return byPhone;
  }

  return null;
}

/**
 * Clientes já cadastrados para as linhas de UM lote, lidos de uma vez (por CPF e por telefone) no lugar de
 * `findExistingClient` linha a linha: no Worker cada consulta é uma chamada ao D1, e 2 por linha estouram o limite
 * por invocação num lote de importação. Mesma prioridade: CPF, depois telefone de cliente não anonimizado.
 * `lembrar` registra o cliente criado ou alterado pelo próprio lote, para que uma linha repetida mais adiante o
 * encontre como encontraria no banco.
 */
export async function clientesExistentes(prisma: AppPrismaClient, tenantId: string, linhas: { cpfHash: string; telefone?: string | null }[]) {
  const cpfs = [...new Set(linhas.map((l) => l.cpfHash))];
  const fones = [...new Set(linhas.map((l) => l.telefone).filter((t): t is string => !!t))];
  const [porCpf, porFone] = await Promise.all([
    cpfs.length ? prisma.client.findMany({ where: { tenantId, cpfHash: { in: cpfs } } }) : Promise.resolve([]),
    // LGPD 03-01: o telefone nunca casa com cliente anonimizado
    fones.length ? prisma.client.findMany({ where: { tenantId, telefone: { in: fones }, anonymizedAt: null } }) : Promise.resolve([]),
  ]);
  type Cliente = (typeof porCpf)[number];
  const cpfMap = new Map<string, Cliente>();
  const foneMap = new Map<string, Cliente>();
  for (const c of porCpf) cpfMap.set(c.cpfHash, c);
  for (const c of porFone) if (!foneMap.has(c.telefone)) foneMap.set(c.telefone, c);

  return {
    achar(row: { cpfHash: string; telefone?: string | null }): Cliente | null {
      return cpfMap.get(row.cpfHash) ?? (row.telefone ? foneMap.get(row.telefone) : undefined) ?? null;
    },
    lembrar(c: Cliente) {
      // a gravação pode ter trocado CPF ou telefone: tira as chaves antigas do mesmo cliente
      for (const m of [cpfMap, foneMap]) for (const [k, v] of m) if (v.id === c.id) m.delete(k);
      cpfMap.set(c.cpfHash, c);
      if (!c.anonymizedAt && !foneMap.has(c.telefone)) foneMap.set(c.telefone, c);
    },
  };
}

/* ───────────────────────── supressão na importação (LGPD 03-01 / 02-02) ───────────────────────── */

/**
 * O que a supressão diz sobre as linhas de UMA importação, consultado em lote (poucas consultas para o arquivo):
 *  - por DOCUMENTO: ELIMINACAO (com a data do pedido) e BLOQUEIO impedem recriar/atualizar o titular;
 *  - por TELEFONE: OPT_OUT/BLOQUEIO (tabela ou opt-out já gravado em qualquer cadastro/lista com o número) fazem
 *    a linha entrar SEM autorização e com opt-out. Telefone nunca faz a linha ser ignorada: o número pode ter
 *    sido reaproveitado pela operadora por outra pessoa.
 */
export interface SupressaoImportacao {
  porDoc: Map<string, Map<string, Date>>; // docHash → motivo → data mais recente
  telefones: LoteSupressao;
}

export async function supressaoDaImportacao(
  prisma: AppPrismaClient,
  tenantId: string,
  linhas: { telefone?: string | null; cpfHash?: string | null }[]
): Promise<SupressaoImportacao> {
  const porDoc = new Map<string, Map<string, Date>>();
  const docs = [...new Set(linhas.map((l) => l.cpfHash).filter((d): d is string => !!d))];
  for (let i = 0; i < docs.length; i += 1000) {
    const rows = await prisma.supressaoTitular.findMany({
      where: { tenantId, docHash: { in: docs.slice(i, i + 1000) } },
      select: { docHash: true, motivo: true, createdAt: true },
    });
    for (const r of rows) {
      if (!r.docHash) continue;
      const m = porDoc.get(r.docHash) ?? new Map<string, Date>();
      const atual = m.get(r.motivo);
      if (!atual || r.createdAt > atual) m.set(r.motivo, r.createdAt);
      porDoc.set(r.docHash, m);
    }
  }
  const telefones = await suprimidosEmLote(prisma, tenantId, { telefones: linhas.map((l) => l.telefone) });
  return { porDoc, telefones };
}

export type DecisaoSupressao =
  | { acao: "IGNORAR"; motivo: "ELIMINADO_A_PEDIDO" | "BLOQUEADO" }
  | { acao: "ENTRAR"; liberarEliminacao: boolean; semAutorizacao: boolean };

/**
 * Decide o que fazer com UMA linha. `dataRelacao` = abertura da conta (ou, sem ela, cadastro) que a planilha traz:
 * se for POSTERIOR ao pedido de eliminação, é uma relação NOVA (a pessoa voltou a contratar) e a linha entra como
 * cliente novo, liberando a supressão daquele documento. Sem data posterior, a mesma linha antiga continua ignorada.
 */
export function decidirSupressao(sup: SupressaoImportacao, linha: { telefone?: string | null; cpfHash: string; dataRelacao?: Date | null }): DecisaoSupressao {
  const doc = sup.porDoc.get(linha.cpfHash);
  if (doc?.has("BLOQUEIO")) return { acao: "IGNORAR", motivo: "BLOQUEADO" };
  const eliminadoEm = doc?.get("ELIMINACAO");
  let liberarEliminacao = false;
  if (eliminadoEm) {
    if (!linha.dataRelacao || linha.dataRelacao.getTime() <= eliminadoEm.getTime()) return { acao: "IGNORAR", motivo: "ELIMINADO_A_PEDIDO" };
    liberarEliminacao = true;
  }
  const c = canonicalPhone(linha.telefone);
  const motivosTel = c ? sup.telefones.motivosPorTelefone.get(c) : undefined;
  const telefoneBloqueia = !!motivosTel && [...motivosTel].some((m) => m !== "ELIMINACAO");
  const docOptOut = !!doc?.has("OPT_OUT");
  return { acao: "ENTRAR", liberarEliminacao, semAutorizacao: telefoneBloqueia || docOptOut };
}

/**
 * LGPD 03-01: remove a supressão por ELIMINACAO de um documento (nova relação vista na planilha, ou liberação
 * manual pelo ADMIN) e registra no AuditLog, sem PII (nem o hash do documento).
 */
export async function liberarEliminacao(
  prisma: AppPrismaClient,
  tenantId: string,
  docHash: string,
  ctx: { motivo: string; origem: string; userId?: string; importJobId?: string }
): Promise<number> {
  const r = await prisma.supressaoTitular.deleteMany({ where: { tenantId, motivo: "ELIMINACAO", docHash } });
  if (r.count > 0) {
    await logAudit({
      tenantId,
      userId: ctx.userId,
      action: "SUPRESSAO_LIBERADA",
      target: "SupressaoTitular",
      details: { motivo: ctx.motivo, origem: ctx.origem, removidas: r.count, ...(ctx.importJobId ? { importJobId: ctx.importJobId } : {}) },
    });
  }
  return r.count;
}

/**
 * LGPD 03-03: tira do update os campos que o titular corrigiu à mão (quando o tenant faz a correção vencer).
 * Devolve os campos em que a planilha DIVERGE da correção (o que a tela avisa: alguém precisa corrigir a planilha).
 */
export function preservarCorrecoes(update: Record<string, unknown>, existing: { camposCorrigidos?: unknown } & Record<string, unknown>): string[] {
  const cc = existing.camposCorrigidos;
  if (!cc || typeof cc !== "object" || Array.isArray(cc)) return [];
  const divergentes: string[] = [];
  for (const campo of Object.keys(cc as Record<string, unknown>)) {
    if (!(campo in update)) continue;
    const novo = update[campo];
    delete update[campo];
    if (novo !== undefined && (novo ?? null) !== (existing[campo] ?? null)) divergentes.push(campo);
  }
  return divergentes;
}

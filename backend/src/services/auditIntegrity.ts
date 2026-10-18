import crypto from "crypto";
import { prisma } from "../config/db";

/**
 * Tamper-evidence para AuditLog (achado #11, docs/security-audit/findings.md): cada entrada
 * nova guarda hash = SHA-256(prevHash + campos-desta-linha) — qualquer alteração ou remoção de
 * uma linha existente quebra a cadeia a partir dali, detectável por verifyAuditChain(). Entradas
 * gravadas antes do #11 (hash/prevHash = null) ficam de fora da cadeia — limitação aceita.
 *
 * LGPD 08-08: a cadeia passa a ser POR TENANT (prevHash = hash da última entrada do MESMO
 * tenant). Antes ela era global, então verificar a integridade de um controlador dependia das
 * linhas dos outros (e a resposta expunha contagem e ids delas), e a eliminação legítima dos
 * dados de um controlador quebrava a prova de todos os outros. Nenhuma leitura aqui é mais
 * cross-tenant.
 *
 * Transição (as linhas antigas foram encadeadas globalmente):
 *  1. Na primeira gravação de um tenant com o código novo, prepareTenantChain() grava antes uma
 *     entrada-ÂNCORA (action ANCORA_CADEIA_TENANT) com prevHash = hash da última linha do
 *     próprio tenant e details { legadoTotal, legadoUltimoHash }: o tamanho e o fim do trecho
 *     legado ficam "selados" dentro da cadeia nova.
 *  2. verifyAuditChain(tenantId) lê só as linhas do tenant e divide na primeira âncora:
 *     - legado (antes da âncora): confere o hash de CONTEÚDO de cada linha e o elo entre linhas
 *       consecutivas do tenant. Quando o prevHash aponta para fora (era a linha de outro tenant
 *       na cadeia global), conta uma "lacuna legada" em vez de dar falso alarme, sem consultar
 *       os outros tenants. Remoção/inserção no legado depois da âncora é pega pelo total e pelo
 *       último hash selados nela.
 *     - âncora: precisa bater com o legado efetivamente encontrado (total, último hash, elo).
 *     - depois da âncora: elo estrito por tenant, como era a cadeia global.
 *  Limitação aceita: uma remoção no legado ANTES da âncora existir (ou de um tenant que ainda
 *  não gravou nada desde o deploy) aparece só como lacuna, indistinguível de uma linha de outro
 *  tenant. Linhas gravadas por uma instância antiga durante o deploy, depois da âncora, aparecem
 *  como quebra.
 *
 * Sem lock explícito na leitura do último hash: sob escrita concorrente real (rara neste volume
 * de auditoria) duas chamadas a logAudit() do mesmo tenant poderiam ler o mesmo prevHash e gerar
 * um "fork" — verifyAuditChain() detecta isso como uma quebra na sequência, igual a uma
 * adulteração de fato. Não introduz SQL cru (`$queryRaw`) para lock explícito porque o volume de
 * escrita deste log é baixo o suficiente para não justificar abrir mão da propriedade "zero SQL
 * cru" já confirmada no restante do backend. Com a cadeia por tenant, o fork só acontece entre
 * escritas concorrentes do mesmo tenant.
 */

/** LGPD 08-08: ação da entrada-âncora que inicia a cadeia por tenant. */
export const ANCORA_CADEIA_TENANT = "AUDIT_CADEIA_POR_TENANT";

export type AuditEntryForHash = {
  tenantId: string;
  userId: string | null;
  action: string;
  target: string | null;
  targetId: string | null;
  details: unknown;
  createdAt: Date;
};

/** Serialização determinística: ordena chaves de objetos recursivamente, ISO para Date. */
function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function computeAuditHash(entry: AuditEntryForHash, prevHash: string | null): string {
  const payload = JSON.stringify({ prevHash, entry: canonicalize(entry) });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export type ChainTip = { hash: string | null; createdAt: Date | null };

/** LGPD 08-08: última entrada encadeada DO TENANT (antes era a última global, cross-tenant). */
async function lastTenantEntry(tenantId: string): Promise<ChainTip> {
  const last = await prisma.auditLog.findFirst({
    where: { tenantId, hash: { not: null } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { hash: true, createdAt: true },
  });
  return { hash: last?.hash ?? null, createdAt: last?.createdAt ?? null };
}

/** Hash da última entrada da cadeia do tenant. */
export async function getLastAuditHash(tenantId: string): Promise<string | null> {
  return (await lastTenantEntry(tenantId)).hash;
}

/**
 * createdAt da próxima entrada: agora, ou 1 ms depois da anterior se o relógio não andou (mesmo
 * milissegundo ou instância com relógio atrasado), para a ordenação por createdAt ser a da cadeia.
 */
export function nextCreatedAt(after: Date | null): Date {
  const now = new Date();
  return after && now.getTime() <= after.getTime() ? new Date(after.getTime() + 1) : now;
}

// Cache por instância: evita procurar a âncora a cada logAudit depois que ela já existe.
const tenantsComAncora = new Set<string>();

/** Só para testes: esquece quais tenants já têm âncora nesta instância. */
export function resetAnchorCache() {
  tenantsComAncora.clear();
}

/**
 * LGPD 08-08: devolve o elo (hash e createdAt) ao qual a próxima entrada do tenant deve se
 * prender. Se o tenant ainda não tem âncora, grava a âncora antes e devolve o elo dela.
 */
export async function prepareTenantChain(tenantId: string): Promise<ChainTip> {
  if (!tenantsComAncora.has(tenantId)) {
    const ancora = await prisma.auditLog.findFirst({
      where: { tenantId, action: ANCORA_CADEIA_TENANT, hash: { not: null } },
      select: { id: true },
    });
    if (!ancora) {
      const tip = await lastTenantEntry(tenantId);
      // Roda uma vez por tenant (só enquanto a âncora não existe). findMany em vez de count para
      // não exigir mais um método do Prisma nos mocks dos outros serviços que gravam auditoria.
      const legado = await prisma.auditLog.findMany({ where: { tenantId, hash: { not: null } }, select: { id: true } });
      const legadoTotal = legado.length;
      const entry: AuditEntryForHash = {
        tenantId,
        userId: null,
        action: ANCORA_CADEIA_TENANT,
        target: "AuditLog",
        targetId: null,
        details: { legadoTotal, legadoUltimoHash: tip.hash },
        createdAt: nextCreatedAt(tip.createdAt),
      };
      const hash = computeAuditHash(entry, tip.hash);
      await prisma.auditLog.create({ data: { ...entry, details: entry.details as any, prevHash: tip.hash, hash } });
      tenantsComAncora.add(tenantId);
      return { hash, createdAt: entry.createdAt };
    }
    tenantsComAncora.add(tenantId);
  }
  return lastTenantEntry(tenantId);
}

export type AuditChainVerification =
  | { valid: true; checked: number; ancora: boolean; lacunasLegado: number }
  | {
      valid: false;
      checked: number;
      ancora: boolean;
      lacunasLegado: number;
      motivo: "CONTEUDO" | "ELO" | "ANCORA";
      brokenAt: { id: string; createdAt: Date };
    };

/**
 * LGPD 08-08: percorre a cadeia de UM tenant (só as linhas dele) e recalcula cada hash. Ver a
 * estratégia de transição no topo do arquivo.
 */
export async function verifyAuditChain(tenantId: string): Promise<AuditChainVerification> {
  const rows = await prisma.auditLog.findMany({
    where: { tenantId, hash: { not: null } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  const ancoraIdx = rows.findIndex((r) => r.action === ANCORA_CADEIA_TENANT);
  const ancora = ancoraIdx !== -1;
  const fimLegado = ancora ? ancoraIdx : rows.length;

  let anterior: string | null = null;
  let checked = 0;
  let lacunasLegado = 0;
  const quebra = (row: (typeof rows)[number], motivo: "CONTEUDO" | "ELO" | "ANCORA"): AuditChainVerification => ({
    valid: false,
    checked,
    ancora,
    lacunasLegado,
    motivo,
    brokenAt: { id: row.id, createdAt: row.createdAt },
  });

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const recomputed = computeAuditHash(
      {
        tenantId: row.tenantId,
        userId: row.userId,
        action: row.action,
        target: row.target,
        targetId: row.targetId,
        details: row.details,
        createdAt: row.createdAt,
      },
      row.prevHash
    );
    if (recomputed !== row.hash) return quebra(row, "CONTEUDO");

    if (i < fimLegado) {
      // Era global: o elo anterior pode ser a linha de outro tenant. Não é quebra, é lacuna.
      if (row.prevHash !== anterior) lacunasLegado++;
    } else if (i === ancoraIdx) {
      const d = (row.details ?? {}) as { legadoTotal?: unknown; legadoUltimoHash?: unknown };
      if (row.prevHash !== anterior || d.legadoTotal !== fimLegado || (d.legadoUltimoHash ?? null) !== anterior) {
        return quebra(row, "ANCORA");
      }
    } else if (row.prevHash !== anterior) {
      return quebra(row, "ELO");
    }

    anterior = row.hash;
    checked++;
  }

  return { valid: true, checked, ancora, lacunasLegado };
}

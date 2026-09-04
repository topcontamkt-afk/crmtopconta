import crypto from "crypto";
import { prisma } from "../config/db";
import { withCrossTenantAccess } from "../config/tenantGuard";

/**
 * Tamper-evidence para AuditLog (achado #11, docs/security-audit/findings.md): cada entrada
 * nova guarda hash = SHA-256(prevHash + campos-desta-linha), formando uma cadeia GLOBAL (todas
 * as tenants, ordenada por createdAt) — qualquer alteração ou remoção de uma linha existente
 * quebra a cadeia a partir dali, detectável por verifyAuditChain(). Entradas gravadas antes
 * desta mudança (hash/prevHash = null) ficam de fora da cadeia — limitação aceita.
 *
 * Sem lock explícito na leitura do último hash: sob escrita concorrente real (rara neste volume
 * de auditoria) duas chamadas a logAudit() poderiam ler o mesmo prevHash e gerar um "fork" —
 * verifyAuditChain() detecta isso como uma quebra na sequência (prevHash não bate com o hash
 * anterior esperado), igual a uma adulteração de fato. Não introduz SQL cru (`$queryRaw`) para
 * lock explícito porque o volume de escrita deste log é baixo o suficiente para não justificar
 * abrir mão da propriedade "zero SQL cru" já confirmada no restante do backend.
 */

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

/** Hash da última entrada da cadeia. Leitura cross-tenant por natureza — a cadeia é global. */
export async function getLastAuditHash(): Promise<string | null> {
  const last = await withCrossTenantAccess(() =>
    prisma.auditLog.findFirst({
      where: { hash: { not: null } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { hash: true },
    })
  );
  return last?.hash ?? null;
}

export type AuditChainVerification =
  | { valid: true; checked: number }
  | { valid: false; checked: number; brokenAt: { id: string; createdAt: Date } };

/** Percorre a cadeia inteira (todas as entradas com hash não-nulo) e recalcula cada hash. */
export async function verifyAuditChain(): Promise<AuditChainVerification> {
  const entries = await withCrossTenantAccess(() =>
    prisma.auditLog.findMany({
      where: { hash: { not: null } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
  );

  let expectedPrevHash: string | null = null;
  let checked = 0;

  for (const row of entries) {
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

    if (row.prevHash !== expectedPrevHash || recomputed !== row.hash) {
      return { valid: false, checked, brokenAt: { id: row.id, createdAt: row.createdAt } };
    }

    expectedPrevHash = row.hash;
    checked++;
  }

  return { valid: true, checked };
}

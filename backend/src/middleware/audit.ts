import { prisma } from "../config/db";
import { computeAuditHash, getLastAuditHash } from "../services/auditIntegrity";

/** Registra uma ação no log de auditoria (LGPD/compliance): quem, o quê, quando, em qual registro. */
export async function logAudit(params: {
  tenantId: string;
  userId?: string;
  action: string;
  target?: string;
  targetId?: string;
  details?: unknown;
}) {
  const createdAt = new Date();
  const prevHash = await getLastAuditHash();
  // Cadeia de hash (achado #11, tamper-evidence — ver services/auditIntegrity.ts): createdAt é
  // gerado aqui em vez de deixar o @default(now()) do schema preencher, para que o valor
  // usado no hash seja exatamente o valor persistido.
  const entry = {
    tenantId: params.tenantId,
    userId: params.userId ?? null,
    action: params.action,
    target: params.target ?? null,
    targetId: params.targetId ?? null,
    details: params.details ?? null,
    createdAt,
  };
  const hash = computeAuditHash(entry, prevHash);

  await prisma.auditLog.create({
    data: { ...entry, details: entry.details as any, prevHash, hash },
  });
}

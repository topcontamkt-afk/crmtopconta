import { prisma } from "../config/db";

/** Registra uma ação no log de auditoria (LGPD/compliance): quem, o quê, quando, em qual registro. */
export async function logAudit(params: {
  tenantId: string;
  userId?: string;
  action: string;
  target?: string;
  targetId?: string;
  details?: unknown;
}) {
  await prisma.auditLog.create({
    data: {
      tenantId: params.tenantId,
      userId: params.userId,
      action: params.action,
      target: params.target,
      targetId: params.targetId,
      details: params.details as any,
    },
  });
}

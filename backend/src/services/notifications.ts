import { AppPrismaClient } from "../config/db";

/**
 * Notificações operacionais (Fase 2 — Should have): "sincronização falhou",
 * "envio bloqueado por falta de autorização", etc. Centraliza a criação para manter
 * consistência de tipo/severidade entre os pontos de disparo (import, scheduler, campanhas).
 */
export async function notify(
  prisma: AppPrismaClient,
  params: {
    tenantId: string;
    type: string;
    severity?: "INFO" | "AVISO" | "ERRO";
    message: string;
    relatedType?: string;
    relatedId?: string;
  }
) {
  return prisma.notification.create({
    data: {
      tenantId: params.tenantId,
      type: params.type,
      severity: params.severity || "INFO",
      message: params.message,
      relatedType: params.relatedType,
      relatedId: params.relatedId,
    },
  });
}

import { PrismaClient } from "@prisma/client";
import { logAudit } from "../middleware/audit";

/**
 * Política de retenção e anonimização (LGPD — right to be forgotten).
 * Clientes sem atividade (dataUltimaUtilizacao) há mais dias que Tenant.retentionDays,
 * e sem movimentação recente, têm seus dados pessoais anonimizados: nome, telefone e CPF
 * deixam de ser reversíveis, mas o histórico agregado (movimentações, métricas de campanha)
 * é preservado para fins estatísticos, conforme permitido pela LGPD para dados anonimizados.
 */
export async function runRetentionSweep(prisma: PrismaClient) {
  const tenants = await prisma.tenant.findMany();
  let totalAnonymized = 0;

  for (const tenant of tenants) {
    const cutoff = new Date(Date.now() - tenant.retentionDays * 24 * 60 * 60 * 1000);

    const candidates = await prisma.client.findMany({
      where: {
        tenantId: tenant.id,
        anonymizedAt: null,
        OR: [
          { dataUltimaUtilizacao: { lte: cutoff } },
          { AND: [{ dataUltimaUtilizacao: null }, { createdAt: { lte: cutoff } }] },
        ],
      },
    });

    for (const client of candidates) {
      await prisma.client.update({
        where: { id: client.id },
        data: {
          nome: "Cliente anonimizado",
          telefone: `anon-${client.id}`,
          cpfHash: `anon-${client.id}`,
          cpfMasked: "***.***.***-**",
          cidade: null,
          autorizacaoComunicacao: false,
          optOutAt: new Date(),
          tags: [],
          anonymizedAt: new Date(),
        },
      });
      await logAudit({
        tenantId: tenant.id,
        action: "RETENTION_ANONYMIZE",
        target: "Client",
        targetId: client.id,
        details: { retentionDays: tenant.retentionDays },
      });
      totalAnonymized++;
    }
  }

  return { totalAnonymized };
}

import { AppPrismaClient } from "../config/db";
import { logAudit } from "../middleware/audit";

/**
 * Mesmos campos PII zerados no `prisma.client.update(...)` de runRetentionSweep abaixo,
 * reaproveitados para saber quais chaves redigir dentro de AuditLog.details (JSON não
 * tipado) quando o cliente correspondente é anonimizado — ver cascadeAuditLogRedaction().
 */
const PII_DETAIL_KEYS = ["nome", "telefone", "cpfHash", "cpfMasked", "cidade", "tags"] as const;
const REDACTED_MARKER = "[redacted-anonimizacao]";

/**
 * Redige, em um objeto `details` de AuditLog (JSON solto, sem schema), qualquer chave de
 * topo cujo nome bata com um campo PII de Client. É uma varredura rasa (não recursiva) —
 * suficiente para o formato de `details` que os call sites de logAudit() hoje produzem
 * (objetos planos), mas não persegue PII escondida dentro de sub-objetos/arrays aninhados.
 * Retorna `changed:false` sem clonar quando não há nada a redigir, para o chamador poder
 * pular o update() nesse caso.
 */
function redactPiiFromDetails(details: unknown): { value: unknown; changed: boolean } {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return { value: details, changed: false };
  }
  const source = details as Record<string, unknown>;
  let changed = false;
  const result: Record<string, unknown> = { ...source };
  for (const key of PII_DETAIL_KEYS) {
    if (key in source) {
      result[key] = REDACTED_MARKER;
      changed = true;
    }
  }
  return { value: result, changed };
}

/**
 * Parte B da anonimização (LGPD): redige PII residual em AuditLog já existentes que
 * referenciam este cliente diretamente por targetId (target="Client", targetId=client.id).
 * Não apaga a linha — "UPDATE_CLIENT aconteceu no instante T" continua sendo histórico de
 * auditoria legítimo — só troca os valores PII dentro do JSON `details` pelo marcador acima.
 *
 * Limitação documentada: isto só alcança entradas endereçáveis por targetId. Entradas que
 * referenciam PII de cliente por valor em vez de por id — ex.: TEST_SEND_CAMPAIGN
 * (routes/campaigns.ts) logava telefones brutos, BULK_* (routes/clients.ts) loga uma lista
 * de clientIds sem um targetId único — não têm como ser correlacionadas de volta a UM
 * client.id específico de forma barata aqui. Para essas, a proteção é não gravar PII bruta
 * em details desde o início (ver os call sites de logAudit() em routes/campaigns.ts e
 * routes/clients.ts, já ajustados para logar apenas contagens/ids/nomes de campo).
 */
async function cascadeAuditLogRedaction(prisma: AppPrismaClient, tenantId: string, clientId: string) {
  const relatedLogs = await prisma.auditLog.findMany({
    where: { tenantId, target: "Client", targetId: clientId },
    select: { id: true, details: true },
  });

  let redactedCount = 0;
  for (const log of relatedLogs) {
    const { value, changed } = redactPiiFromDetails(log.details);
    if (!changed) continue;
    // update() por id único, não coberto pelo guard de tenantId (ver tenantGuard.ts) — mas
    // seguro pelo mesmo padrão "verify-then-act" usado no resto do app: o id só veio do
    // findMany acima, que já foi escopado por tenantId.
    await prisma.auditLog.update({ where: { id: log.id }, data: { details: value as any } });
    redactedCount++;
  }
  return redactedCount;
}

/**
 * Política de retenção e anonimização (LGPD — right to be forgotten).
 * Clientes sem atividade (dataUltimaUtilizacao) há mais dias que Tenant.retentionDays,
 * e sem movimentação recente, têm seus dados pessoais anonimizados: nome, telefone e CPF
 * deixam de ser reversíveis, mas o histórico agregado (movimentações, métricas de campanha)
 * é preservado para fins estatísticos, conforme permitido pela LGPD para dados anonimizados.
 * Em seguida, cascadeia a mesma anonimização para o AuditLog (ver cascadeAuditLogRedaction).
 */
export async function runRetentionSweep(prisma: AppPrismaClient) {
  const tenants = await prisma.tenant.findMany();
  let totalAnonymized = 0;
  let totalAuditLogsRedacted = 0;

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

      totalAuditLogsRedacted += await cascadeAuditLogRedaction(prisma, tenant.id, client.id);
    }
  }

  return { totalAnonymized, auditLogsRedacted: totalAuditLogsRedacted };
}

import crypto from "crypto";
import { AppPrismaClient } from "../config/db";
import { decryptSecret, encryptSecret, isEncryptedPayload } from "./crypto";

/**
 * Credenciais da Meta por conta (WhatsAppAccount): configuradas na tela de Integrações, guardadas
 * cifradas (AES-256-GCM, services/crypto.ts) e usadas por webhook, campanhas, inbox, mídia e templates.
 * As variáveis de ambiente WHATSAPP_* só valem como reserva quando liberadas (ver globalCredentialsAllowed).
 */
export interface WhatsAppCredentials {
  accessToken: string | undefined;
  appSecret: string | undefined;
}

type AccountLike = { credentials?: unknown; tenantId?: string | null } | null | undefined;

/**
 * LGPD 06-01: a credencial GLOBAL do ambiente (WHATSAPP_*, TWILIO_*) é da conta e do contrato de quem hospeda
 * o CRM, não da controladora. Tráfego de um tenant só sai por ela quando liberado de propósito:
 *  - `ALLOW_GLOBAL_CHANNEL_CREDENTIALS=true`: qualquer tenant (dev/sandbox; nunca em produção multi-tenant);
 *  - `PLATFORM_DEFAULT_TENANT_ID=<id>`: só o tenant dono das credenciais do ambiente (legado de um tenant só).
 * Sem nenhuma das duas, cada tenant precisa do próprio canal (Integrações / Configurações).
 */
export function globalCredentialsAllowed(tenantId: string | null | undefined): boolean {
  if (process.env.ALLOW_GLOBAL_CHANNEL_CREDENTIALS === "true") return true;
  const dono = process.env.PLATFORM_DEFAULT_TENANT_ID?.trim();
  return !!dono && !!tenantId && tenantId === dono;
}

/**
 * Decifra as credenciais da conta. Reserva no ambiente:
 *  - accessToken (ENVIA dados de clientes à Meta): só com `globalCredentialsAllowed(account.tenantId)` (LGPD 06-01);
 *  - appSecret (só CONFERE a assinatura do webhook da Meta, não envia nada): continua valendo, porque o segredo é
 *    do app da Meta que recebe os webhooks e tirá-lo faria o webhook ignorar mensagens (inclusive pedidos de PARAR).
 */
export function credentialsOf(account: AccountLike): WhatsAppCredentials {
  let accessToken: string | undefined;
  let appSecret: string | undefined;
  const payload = account?.credentials;
  if (payload && isEncryptedPayload(payload)) {
    try {
      const c = decryptSecret(payload) as { accessToken?: string; appSecret?: string };
      accessToken = c.accessToken || undefined;
      appSecret = c.appSecret || undefined;
    } catch (e) {
      console.error("[whatsappAccount] não foi possível decifrar as credenciais:", (e as Error).message);
    }
  }
  return {
    accessToken: accessToken ?? (globalCredentialsAllowed(account?.tenantId) ? process.env.WHATSAPP_ACCESS_TOKEN || undefined : undefined),
    appSecret: appSecret ?? (process.env.WHATSAPP_APP_SECRET || undefined),
  };
}

export function encryptCredentials(c: { accessToken: string; appSecret: string }) {
  return encryptSecret({ accessToken: c.accessToken, appSecret: c.appSecret });
}

/** Os 4 últimos caracteres, para a tela mostrar "••••abcd" sem expor o segredo. */
export const hint = (secret: string) => secret.slice(-4);

export function generateVerifyToken(): string {
  return crypto.randomUUID();
}

/** Token da conta ativa do tenant (ou da conta indicada). */
export async function accessTokenFor(prisma: AppPrismaClient, tenantId: string, accountId?: string): Promise<string | undefined> {
  const account = await prisma.whatsAppAccount.findFirst({
    where: { tenantId, active: true, provider: "META", ...(accountId ? { id: accountId } : {}) },
    orderBy: { createdAt: "asc" },
  });
  return credentialsOf(account ?? { tenantId }).accessToken;
}

/** Máscara para exibição: ●●●●●●●●abcd */
export function maskedHint(h: string | null | undefined): string | null {
  return h ? `${"•".repeat(24)}${h}` : null;
}

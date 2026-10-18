import crypto from "crypto";
import { AppPrismaClient } from "../config/db";
import { decryptSecret, encryptSecret, isEncryptedPayload } from "./crypto";

/**
 * Credenciais da Meta por conta (WhatsAppAccount): configuradas na tela de Integrações, guardadas
 * cifradas (AES-256-GCM, services/crypto.ts) e usadas por webhook, campanhas, inbox, mídia e templates.
 * As variáveis de ambiente WHATSAPP_* continuam valendo só como reserva para quem ainda não configurou
 * pela tela (compatibilidade).
 */
export interface WhatsAppCredentials {
  accessToken: string | undefined;
  appSecret: string | undefined;
}

type AccountLike = { credentials?: unknown } | null | undefined;

/** Decifra as credenciais da conta; sem elas cai nas variáveis de ambiente (reserva). */
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
    accessToken: accessToken ?? (process.env.WHATSAPP_ACCESS_TOKEN || undefined),
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
  return credentialsOf(account).accessToken;
}

/** Máscara para exibição: ●●●●●●●●abcd */
export function maskedHint(h: string | null | undefined): string | null {
  return h ? `${"•".repeat(24)}${h}` : null;
}

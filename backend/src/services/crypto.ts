import crypto from "crypto";

/**
 * Envelope encryption para segredos em repouso (ex.: credenciais de canal em ChannelConfig).
 * Simula uma KMS: a chave mestra vem de uma variável de ambiente (CREDENTIALS_ENCRYPTION_KEY,
 * 32 bytes em base64) em vez de um serviço de KMS externo (AWS/GCP/Azure KMS ou HSM) — a troca
 * para uma KMS real é apenas trocar `getMasterKey()` por uma chamada ao SDK do provedor, sem
 * alterar o restante do fluxo de cifra/decifra.
 */

export interface EncryptedPayload {
  iv: string; // base64
  authTag: string; // base64
  ciphertext: string; // base64
}

function getMasterKey(): Buffer {
  const raw = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "CREDENTIALS_ENCRYPTION_KEY não configurada. Gere uma chave com " +
        "`openssl rand -base64 32` e configure-a antes de salvar credenciais de canal."
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("CREDENTIALS_ENCRYPTION_KEY deve ter 32 bytes (AES-256) codificados em base64.");
  }
  return key;
}

export function encryptSecret(plaintext: Record<string, unknown>): EncryptedPayload {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plaintext), "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptSecret(payload: EncryptedPayload): Record<string, unknown> {
  const key = getMasterKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

export function isEncryptedPayload(value: unknown): value is EncryptedPayload {
  return (
    !!value &&
    typeof value === "object" &&
    "iv" in (value as any) &&
    "authTag" in (value as any) &&
    "ciphertext" in (value as any)
  );
}

import { authenticator } from "otplib";
import QRCode from "qrcode";
import { decryptSecret, encryptSecret, isEncryptedPayload } from "./crypto";

/**
 * 2FA via TOTP (Time-based One-Time Password — compatível com Google Authenticator, Authy etc.).
 * O segredo é cifrado em repouso (mesma envelope encryption usada para credenciais de canal) e
 * nunca é enviado ao frontend depois do setup inicial — só o QR code/otpauth URI naquele momento.
 */

const ISSUER = "CRM TopConta";

export function generateSecret(): string {
  return authenticator.generateSecret();
}

export function buildOtpAuthUri(email: string, secret: string): string {
  return authenticator.keyuri(email, ISSUER, secret);
}

export async function buildQrCodeDataUri(otpAuthUri: string): Promise<string> {
  return QRCode.toDataURL(otpAuthUri);
}

export function verifyToken(token: string, secret: string): boolean {
  try {
    return authenticator.check(token, secret);
  } catch {
    return false;
  }
}

/** Cifra o segredo TOTP para armazenar em User.twoFactorSecret. */
export function encryptTwoFactorSecret(secret: string): string {
  return JSON.stringify(encryptSecret({ secret }));
}

/** Decifra o segredo armazenado em User.twoFactorSecret. */
export function decryptTwoFactorSecret(stored: string): string {
  const payload = JSON.parse(stored);
  if (!isEncryptedPayload(payload)) throw new Error("Segredo 2FA armazenado em formato inválido");
  const { secret } = decryptSecret(payload) as { secret: string };
  return secret;
}

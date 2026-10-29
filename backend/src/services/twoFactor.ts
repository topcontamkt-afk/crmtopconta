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

/**
 * QR code como SVG em data URI. O PNG (`toDataURL`) usa zlib/pngjs, que trava a requisição no Worker;
 * o SVG é texto puro e a tela mostra do mesmo jeito (`<img src>`).
 */
export async function buildQrCodeDataUri(otpAuthUri: string): Promise<string> {
  const svg = await QRCode.toString(otpAuthUri, { type: "svg", margin: 1 });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
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

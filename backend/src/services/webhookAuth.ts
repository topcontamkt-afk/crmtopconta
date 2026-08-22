import crypto from "crypto";

/**
 * Verificação de assinatura dos webhooks públicos de status (WhatsApp / SMS). Extraído como
 * funções puras (sem Express/DB) para serem testáveis isoladamente — ver webhookAuth.test.ts.
 */

/**
 * Reproduz o algoritmo de assinatura da Twilio: base64(HMAC-SHA1(authToken, url + params
 * ordenados e concatenados como chave+valor)). Ver
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export function computeTwilioSignature(
  url: string,
  params: Record<string, string>,
  authToken: string
): string {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }
  return crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}

/**
 * Compara a assinatura recebida no header X-Twilio-Signature com a calculada localmente, usando
 * comparação em tempo constante. Retorna false (nunca lança) para qualquer entrada ausente/
 * inválida.
 */
export function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string | undefined,
  authToken: string | undefined
): boolean {
  if (!signature || !authToken) return false;
  const expected = computeTwilioSignature(url, params, authToken);

  const signatureBuf = Buffer.from(signature, "utf-8");
  const expectedBuf = Buffer.from(expected, "utf-8");
  if (signatureBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(signatureBuf, expectedBuf);
}

/**
 * Reproduz o algoritmo de assinatura da Meta (WhatsApp Cloud API): hex(HMAC-SHA256(appSecret,
 * corpo bruto da requisição)), enviado no header X-Hub-Signature-256 como "sha256=<hex>". Ver
 * https://developers.facebook.com/docs/graph-api/webhooks/getting-started#validating-payloads
 */
export function computeWhatsAppSignature(rawBody: Buffer | string, appSecret: string): string {
  return crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
}

/**
 * Compara a assinatura recebida no header X-Hub-Signature-256 (formato "sha256=<hex>") com a
 * calculada a partir do corpo bruto da requisição, usando comparação em tempo constante. Retorna
 * false (nunca lança) para qualquer entrada ausente/inválida/malformada.
 */
export function verifyWhatsAppSignature(
  rawBody: Buffer | string,
  signature: string | undefined,
  appSecret: string | undefined
): boolean {
  if (!signature || !appSecret) return false;
  const prefix = "sha256=";
  if (!signature.startsWith(prefix)) return false;

  const provided = signature.slice(prefix.length);
  const expected = computeWhatsAppSignature(rawBody, appSecret);

  // hex inválido em `provided` gera um Buffer truncado (mais curto), o que já falha no check de
  // tamanho abaixo sem lançar — nunca deixa passar um valor malformado.
  const providedBuf = Buffer.from(provided, "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

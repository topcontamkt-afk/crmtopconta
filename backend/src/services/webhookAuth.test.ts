import crypto from "crypto";
import {
  computeTwilioSignature,
  computeWhatsAppSignature,
  verifyTwilioSignature,
  verifyWhatsAppSignature,
} from "./webhookAuth";

describe("verifyTwilioSignature", () => {
  const url = "https://example.com/api/integrations/webhooks/sms/twilio";
  const params = { MessageSid: "SM123", MessageStatus: "delivered" };
  const authToken = "auth-token-123";

  it("aceita uma assinatura válida", () => {
    const signature = computeTwilioSignature(url, params, authToken);
    expect(verifyTwilioSignature(url, params, signature, authToken)).toBe(true);
  });

  it("rejeita quando a assinatura está ausente", () => {
    expect(verifyTwilioSignature(url, params, undefined, authToken)).toBe(false);
  });

  it("rejeita quando o authToken não está configurado", () => {
    const signature = computeTwilioSignature(url, params, authToken);
    expect(verifyTwilioSignature(url, params, signature, undefined)).toBe(false);
  });

  it("rejeita quando o payload foi adulterado (params diferentes dos assinados)", () => {
    const signature = computeTwilioSignature(url, params, authToken);
    const tamperedParams = { ...params, MessageStatus: "failed" };
    expect(verifyTwilioSignature(url, tamperedParams, signature, authToken)).toBe(false);
  });

  it("rejeita quando assinado com o token errado", () => {
    const signature = computeTwilioSignature(url, params, "outro-token");
    expect(verifyTwilioSignature(url, params, signature, authToken)).toBe(false);
  });

  it("rejeita uma assinatura de tamanho diferente sem lançar", () => {
    expect(() => verifyTwilioSignature(url, params, "abc", authToken)).not.toThrow();
    expect(verifyTwilioSignature(url, params, "abc", authToken)).toBe(false);
  });
});

describe("verifyWhatsAppSignature", () => {
  const appSecret = "meta-app-secret";
  const rawBody = Buffer.from(JSON.stringify({ entry: [{ changes: [] }] }));

  it("aceita uma assinatura válida no formato sha256=<hex>", () => {
    const signature = `sha256=${computeWhatsAppSignature(rawBody, appSecret)}`;
    expect(verifyWhatsAppSignature(rawBody, signature, appSecret)).toBe(true);
  });

  it("rejeita quando a assinatura está ausente", () => {
    expect(verifyWhatsAppSignature(rawBody, undefined, appSecret)).toBe(false);
  });

  it("rejeita quando o appSecret não está configurado", () => {
    const signature = `sha256=${computeWhatsAppSignature(rawBody, appSecret)}`;
    expect(verifyWhatsAppSignature(rawBody, signature, undefined)).toBe(false);
  });

  it("rejeita quando o payload foi adulterado após a assinatura ser calculada", () => {
    const signature = `sha256=${computeWhatsAppSignature(rawBody, appSecret)}`;
    const tamperedBody = Buffer.from(JSON.stringify({ entry: [{ changes: [{ tampered: true }] }] }));
    expect(verifyWhatsAppSignature(tamperedBody, signature, appSecret)).toBe(false);
  });

  it("rejeita quando assinado com o secret errado", () => {
    const signature = `sha256=${computeWhatsAppSignature(rawBody, "outro-secret")}`;
    expect(verifyWhatsAppSignature(rawBody, signature, appSecret)).toBe(false);
  });

  it("rejeita quando o header não tem o prefixo sha256=", () => {
    const digest = computeWhatsAppSignature(rawBody, appSecret);
    expect(verifyWhatsAppSignature(rawBody, digest, appSecret)).toBe(false);
  });

  it("rejeita hex malformado sem lançar", () => {
    expect(() => verifyWhatsAppSignature(rawBody, "sha256=zz", appSecret)).not.toThrow();
    expect(verifyWhatsAppSignature(rawBody, "sha256=zz", appSecret)).toBe(false);
  });
});

describe("computeTwilioSignature / computeWhatsAppSignature (compatibilidade com os algoritmos documentados)", () => {
  it("Twilio: bate com HMAC-SHA1 base64 calculado manualmente", () => {
    const url = "https://example.com/hook";
    const params = { b: "2", a: "1" };
    const authToken = "token";
    const expected = crypto
      .createHmac("sha1", authToken)
      .update(Buffer.from(url + "a1b2", "utf-8"))
      .digest("base64");
    expect(computeTwilioSignature(url, params, authToken)).toBe(expected);
  });

  it("WhatsApp: bate com HMAC-SHA256 hex calculado manualmente", () => {
    const body = Buffer.from("payload");
    const secret = "secret";
    const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
    expect(computeWhatsAppSignature(body, secret)).toBe(expected);
  });
});

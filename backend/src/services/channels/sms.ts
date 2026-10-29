import crypto from "crypto";
import { ChannelAdapter, SendResult } from "./types";
import { isOptOutMessage, normalizeText } from "../whatsappPayload";

/**
 * Adaptador SMS — abstração de provedor único no MVP (ex.: Twilio).
 * A interface unificada permite trocar/adicionar provedores (fallback multi-provider)
 * sem alterar o restante do pipeline de envio (fila/worker).
 */
export class TwilioSMSAdapter implements ChannelAdapter {
  channel: "SMS" = "SMS";

  constructor(
    private accountSid: string,
    private authToken: string,
    private fromNumber: string
  ) {}

  async send(to: string, body: string): Promise<SendResult> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    const basicAuth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64");

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicAuth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: to, From: this.fromNumber, Body: body }).toString(),
      });
      const json: any = await resp.json();
      if (!resp.ok) {
        return { providerMessageId: "", status: "FAILED", error: json.message || JSON.stringify(json) };
      }
      return { providerMessageId: json.sid, status: "SENT" };
    } catch (e: any) {
      return { providerMessageId: "", status: "FAILED", error: e.message };
    }
  }
}

export class MockSMSAdapter implements ChannelAdapter {
  channel: "SMS" = "SMS";
  async send(to: string, body: string): Promise<SendResult> {
    return { providerMessageId: `mock-sms-${Date.now()}`, status: "SENT", cost: 0.08 };
  }
}

/**
 * Segundo provedor de SMS de referência (Zenvia), usado para demonstrar o failover
 * multi-provider (Fase 2 — Should have): quando o provedor de maior prioridade falha,
 * o próximo da lista é tentado automaticamente pelo dispatcher.
 */
export class ZenviaSMSAdapter implements ChannelAdapter {
  channel: "SMS" = "SMS";

  constructor(private apiToken: string, private fromNumber: string) {}

  async send(to: string, body: string): Promise<SendResult> {
    const url = "https://api.zenvia.com/v2/channels/sms/messages";
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "X-API-TOKEN": this.apiToken, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: this.fromNumber,
          to,
          contents: [{ type: "text", text: body }],
        }),
      });
      const json: any = await resp.json();
      if (!resp.ok) {
        return { providerMessageId: "", status: "FAILED", error: json.message || JSON.stringify(json) };
      }
      return { providerMessageId: json.id, status: "SENT" };
    } catch (e: any) {
      return { providerMessageId: "", status: "FAILED", error: e.message };
    }
  }
}

/* ---------------------------------------------------------------------------------------------
 * Webhook de SMS (LGPD 02-04 / 05-05): leitura do corpo (status de entrega E mensagem recebida do
 * titular) e conferência do segredo do canal. Funções puras, testadas em sms.test.ts.
 * ------------------------------------------------------------------------------------------- */

export type SmsWebhookEvent =
  | { kind: "status"; providerMsgId: string; status: string }
  | { kind: "inbound"; providerMsgId: string | null; from: string; to: string | null; body: string };

/** Status da Zenvia (v2) no vocabulário de nextEventStatus (sent/delivered/read/failed). */
const ZENVIA_STATUS: Record<string, string> = { SENT: "sent", DELIVERED: "delivered", READ: "read", NOT_DELIVERED: "failed", REJECTED: "failed" };

/**
 * Normaliza o corpo do webhook para eventos. Twilio (form-encoded): `MessageSid` + `MessageStatus`/`SmsStatus`
 * para status; mensagem RECEBIDA traz `From`/`Body` com status "received" (ou sem status). Zenvia v2 (JSON):
 * `MESSAGE_STATUS` (messageId + messageStatus.code) e `MESSAGE` com direction "IN". Formato antigo
 * `{ sid, status }` continua aceito para status.
 */
export function parseSmsWebhook(provider: string, body: any): SmsWebhookEvent[] {
  const b = body ?? {};
  if (provider === "twilio") {
    const sid = b.MessageSid || b.SmsSid || null;
    const status = String(b.MessageStatus || b.SmsStatus || "").toLowerCase();
    if (b.From && typeof b.Body === "string" && (status === "received" || status === "")) {
      return [{ kind: "inbound", providerMsgId: sid, from: String(b.From), to: b.To ? String(b.To) : null, body: b.Body }];
    }
    return sid && status ? [{ kind: "status", providerMsgId: String(sid), status }] : [];
  }
  if (b.type === "MESSAGE" && String(b.direction ?? b.message?.direction ?? "").toUpperCase() === "IN") {
    const m = b.message ?? {};
    const texto = (m.contents ?? []).filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text).join(" ");
    return m.from ? [{ kind: "inbound", providerMsgId: m.id ? String(m.id) : null, from: String(m.from), to: m.to ? String(m.to) : null, body: texto }] : [];
  }
  if (b.type === "MESSAGE_STATUS" && b.messageId && b.messageStatus?.code) {
    const status = ZENVIA_STATUS[String(b.messageStatus.code).toUpperCase()];
    return status ? [{ kind: "status", providerMsgId: String(b.messageId), status }] : [];
  }
  const sid = b.MessageSid || b.sid;
  const status = b.MessageStatus || b.status;
  return sid && status ? [{ kind: "status", providerMsgId: String(sid), status: String(status) }] : [];
}

/** Palavras-padrão de descadastro de SMS (as que a Twilio e as operadoras reconhecem), além das do WhatsApp. */
const SMS_STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "parar", "sair", "cancelar"]);

/** LGPD 02-04: o titular respondeu ao SMS pedindo para parar? */
export function isSmsOptOut(text: string | null | undefined): boolean {
  const t = normalizeText(text ?? "");
  return SMS_STOP_WORDS.has(t) || isOptOutMessage(t);
}

/**
 * LGPD 05-05: confere o segredo compartilhado do webhook (ChannelConfig.webhookSecret) em tempo constante.
 * Compara os SHA-256 dos dois valores, para o tempo não depender nem do conteúdo nem do tamanho.
 */
export function smsWebhookSecretOk(provided: string | null | undefined, expected: string | null | undefined): boolean {
  if (!provided || !expected) return false;
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b) && provided.length === expected.length;
}

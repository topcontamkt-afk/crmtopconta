import { ChannelAdapter, SendResult } from "./types";

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

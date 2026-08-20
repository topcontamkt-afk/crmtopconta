import { ChannelAdapter, SendResult } from "./types";

/**
 * Adaptador WhatsApp Cloud API (Meta).
 * Requer: WHATSAPP_PHONE_NUMBER_ID e WHATSAPP_ACCESS_TOKEN (ou credenciais por tenant
 * vindas de ChannelConfig — aqui usamos env como fallback simples para o MVP).
 * Em produção as credenciais devem vir de ChannelConfig.credentials (KMS-encrypted).
 */
export class WhatsAppCloudAdapter implements ChannelAdapter {
  channel: "WHATSAPP" = "WHATSAPP";

  constructor(
    private phoneNumberId: string,
    private accessToken: string,
    private apiVersion = "v20.0"
  ) {}

  async send(to: string, body: string): Promise<SendResult> {
    const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body },
        }),
      });

      const json: any = await resp.json();
      if (!resp.ok) {
        return { providerMessageId: "", status: "FAILED", error: JSON.stringify(json.error || json) };
      }
      return { providerMessageId: json.messages?.[0]?.id ?? "", status: "SENT" };
    } catch (e: any) {
      return { providerMessageId: "", status: "FAILED", error: e.message };
    }
  }
}

/** Adaptador mock — usado em dev/sandbox e testes automatizados sem custo/credenciais reais. */
export class MockWhatsAppAdapter implements ChannelAdapter {
  channel: "WHATSAPP" = "WHATSAPP";
  async send(to: string, body: string): Promise<SendResult> {
    return { providerMessageId: `mock-wa-${Date.now()}`, status: "SENT", cost: 0.05 };
  }
}

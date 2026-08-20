/** Abstração de canal — permite plugar WhatsApp Cloud API, SMS (Twilio/Zenvia/...) e futuros canais. */
export interface SendResult {
  providerMessageId: string;
  status: "SENT" | "FAILED";
  error?: string;
  cost?: number;
}

export interface ChannelAdapter {
  channel: "WHATSAPP" | "SMS";
  send(to: string, body: string, meta?: Record<string, unknown>): Promise<SendResult>;
}

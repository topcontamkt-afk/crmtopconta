import { ChannelAdapter, SendResult } from "./types";
import { ZapiCredentials, zapiSendText } from "../zapi";

/**
 * Adaptador Z-API para campanhas: SÓ texto livre (sem template, sem imagem, sem botão). Como a Z-API é uma
 * sessão do WhatsApp Web, envio em rajada derruba o número: cada mensagem espera um intervalo aleatório
 * curto e pede à Z-API um atraso próprio (`delayMessage`). O lote por chamada é limitado em campaignQueue.
 */
export const ZAPI_BATCH_MAX = 4;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ZapiAdapter implements ChannelAdapter {
  channel: "WHATSAPP" = "WHATSAPP";
  constructor(private creds: ZapiCredentials, private fetchImpl?: any, private pause: (ms: number) => Promise<void> = sleep) {}

  async send(to: string, body: string): Promise<SendResult> {
    try {
      await this.pause(700 + Math.floor(Math.random() * 800));
      const id = await zapiSendText(this.creds, to, body, { delayMessage: 2 + Math.floor(Math.random() * 4) }, this.fetchImpl);
      return { providerMessageId: id, status: "SENT" };
    } catch (e: any) {
      return { providerMessageId: "", status: "FAILED", error: e.message };
    }
  }
}

import { WHATSAPP_API_VERSION, baseMime } from "./whatsappMedia";
import { JANELA_HORAS } from "./whatsappPayload";

/**
 * Envio de mensagens pelo WhatsApp Cloud API a um cliente que JÁ escreveu (resposta dentro da janela
 * de 24 horas). Fora da janela só template aprovado vale (Fase 4) — por isso `assertJanelaAberta`.
 * Funções com `fetchImpl` injetável para teste.
 */

export const OUTBOUND_MAX_BYTES = 3 * 1024 * 1024; // base64 vira ~4 MB; a Vercel aceita ~4,5 MB por requisição
export const TEXT_MAX_CHARS = 4096; // limite da Meta para texto

export type OutboundMediaType = "image" | "document" | "audio" | "video";

/** Tipos aceitos pela Meta, por categoria. */
const MEDIA_RULES: Record<OutboundMediaType, string[]> = {
  image: ["image/jpeg", "image/png"],
  document: ["application/pdf"],
  audio: ["audio/ogg", "audio/mpeg", "audio/mp4", "audio/aac", "audio/amr"],
  video: ["video/mp4", "video/3gpp"],
};

export function mediaTypeForMime(mime: string): OutboundMediaType | null {
  const m = baseMime(mime);
  for (const [tipo, mimes] of Object.entries(MEDIA_RULES)) if (mimes.includes(m)) return tipo as OutboundMediaType;
  return null;
}

export class SendError extends Error {
  constructor(public code: "NAO_ENCONTRADA" | "OPT_OUT" | "TEMPLATE_INDISPONIVEL" | "JANELA_FECHADA" | "SEM_TOKEN" | "TIPO_INVALIDO" | "MUITO_GRANDE" | "META", message: string, public metaCode?: number) {
    super(message);
  }
}

/** A resposta livre só vale até 24h depois da última mensagem do CLIENTE. */
export function janelaAberta(lastInboundAt: Date | null | undefined, now = new Date()): boolean {
  return !!lastInboundAt && now.getTime() - lastInboundAt.getTime() < JANELA_HORAS * 3600_000;
}

export function assertJanelaAberta(lastInboundAt: Date | null | undefined, now = new Date()) {
  if (!janelaAberta(lastInboundAt, now)) {
    throw new SendError("JANELA_FECHADA", "A janela de 24 horas está fechada: só é possível enviar um template aprovado.");
  }
}

/** Erros frequentes da Meta, explicados para quem atende. */
export function explainMetaError(code: number | undefined, fallback: string): string {
  const map: Record<number, string> = {
    131047: "Passou de 24 horas desde a última mensagem do cliente: é preciso enviar um template aprovado.",
    131026: "A mensagem não pôde ser entregue: o número não tem WhatsApp ou o cliente bloqueou/não aceitou os termos.",
    131030: "Este número não está na lista de destinatários permitidos (comum no número de teste da Meta).",
    131031: "A conta do WhatsApp Business está bloqueada ou restrita pela Meta.",
    131042: "Há um problema de pagamento na conta do WhatsApp Business.",
    131049: "A Meta não entregou para proteger a qualidade do ecossistema (muitas mensagens sem resposta).",
    131053: "A Meta não conseguiu processar o arquivo (formato ou tamanho não aceito).",
    132000: "Parâmetros do template não conferem.",
    190: "O token de acesso da Meta expirou ou é inválido.",
    100: "A Meta recusou os dados enviados.",
  };
  return (code !== undefined && map[code]) || fallback;
}

type FetchLike = (url: string, init?: any) => Promise<any>;

const timeout = () => AbortSignal.timeout(15_000);
const base = (phoneNumberId: string) => `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${encodeURIComponent(phoneNumberId)}`;

async function parseMetaError(r: any): Promise<SendError> {
  const j = await r.json().catch(() => ({}));
  const err = j?.error ?? {};
  const code = typeof err.code === "number" ? err.code : undefined;
  const detail = err.error_data?.details || err.message || `HTTP ${r.status}`;
  return new SendError("META", explainMetaError(code, `A Meta recusou o envio: ${detail}`), code);
}

async function post(url: string, token: string, body: unknown, fetchImpl: FetchLike): Promise<string> {
  let r: any;
  try {
    r = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: timeout(),
    });
  } catch (e) {
    throw new SendError("META", `Não foi possível falar com a Meta: ${(e as Error).message}`);
  }
  if (!r.ok) throw await parseMetaError(r);
  const j = await r.json();
  const wamid = j?.messages?.[0]?.id;
  if (!wamid) throw new SendError("META", "A Meta aceitou, mas não devolveu o id da mensagem.");
  return String(wamid);
}

export async function sendText(phoneNumberId: string, token: string | undefined, to: string, text: string, fetchImpl: FetchLike = fetch as any): Promise<string> {
  if (!token) throw new SendError("SEM_TOKEN", "WHATSAPP_ACCESS_TOKEN não configurado.");
  return post(`${base(phoneNumberId)}/messages`, token, { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body: text, preview_url: false } }, fetchImpl);
}

/** Sobe o arquivo para a Meta e devolve o `media_id`. */
export async function uploadMedia(phoneNumberId: string, token: string | undefined, data: Buffer, mime: string, filename: string, fetchImpl: FetchLike = fetch as any): Promise<string> {
  if (!token) throw new SendError("SEM_TOKEN", "WHATSAPP_ACCESS_TOKEN não configurado.");
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", baseMime(mime));
  form.append("file", new Blob([new Uint8Array(data)], { type: baseMime(mime) }), filename);
  let r: any;
  try {
    r = await fetchImpl(`${base(phoneNumberId)}/media`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form, signal: timeout() });
  } catch (e) {
    throw new SendError("META", `Não foi possível enviar o arquivo à Meta: ${(e as Error).message}`);
  }
  if (!r.ok) throw await parseMetaError(r);
  const j = await r.json();
  if (!j?.id) throw new SendError("META", "A Meta não devolveu o id do arquivo.");
  return String(j.id);
}

export async function sendMedia(
  phoneNumberId: string,
  token: string | undefined,
  to: string,
  tipo: OutboundMediaType,
  mediaId: string,
  opts: { caption?: string; filename?: string },
  fetchImpl: FetchLike = fetch as any
): Promise<string> {
  if (!token) throw new SendError("SEM_TOKEN", "WHATSAPP_ACCESS_TOKEN não configurado.");
  const payload: Record<string, unknown> = { id: mediaId };
  // Legenda vale para imagem, vídeo e documento; áudio não aceita legenda.
  if (opts.caption && tipo !== "audio") payload.caption = opts.caption;
  if (tipo === "document" && opts.filename) payload.filename = opts.filename;
  return post(`${base(phoneNumberId)}/messages`, token, { messaging_product: "whatsapp", recipient_type: "individual", to, type: tipo, [tipo]: payload }, fetchImpl);
}

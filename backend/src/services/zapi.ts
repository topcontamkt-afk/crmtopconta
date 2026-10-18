import { decryptSecret, encryptSecret, isEncryptedPayload } from "./crypto";
import { InboundMessage } from "./whatsappPayload";

/**
 * Z-API: WhatsApp NÃO oficial (sessão do WhatsApp Web lida por QR code). Formato conferido na documentação
 * oficial (github.com/Z-API/z-api-docs): base `https://api.z-api.io/instances/{ID}/token/{TOKEN}/...`, cabeçalho
 * `Client-Token` (token de segurança da conta) e webhook "ao receber" com `type: "ReceivedCallback"`.
 * Puro/injetável (fetch como parâmetro) para testar sem rede. Os segredos ficam cifrados em
 * `WhatsAppAccount.credentials` ({ token, clientToken }); `phoneNumberId` guarda "zapi:<instanceId>".
 */
export const ZAPI_BASE = "https://api.z-api.io";
export const zapiAccountKey = (instanceId: string) => `zapi:${instanceId}`;
export const instanceIdOf = (phoneNumberId: string) => phoneNumberId.replace(/^zapi:/, "");

export interface ZapiCredentials {
  instanceId: string;
  token: string;
  clientToken?: string;
}

type FetchLike = (url: string, init?: any) => Promise<any>;

export class ZapiError extends Error {
  constructor(public code: "SEM_CREDENCIAL" | "ZAPI" | "REDE", message: string) {
    super(message);
  }
}

export function encryptZapiCredentials(c: { token: string; clientToken?: string }) {
  return encryptSecret({ token: c.token, clientToken: c.clientToken ?? "" });
}

/** Decifra { token, clientToken } da conta; instanceId vem de `phoneNumberId`. */
export function zapiCredentialsOf(account: { phoneNumberId: string; credentials?: unknown } | null | undefined): ZapiCredentials | null {
  if (!account || !isEncryptedPayload(account.credentials)) return null;
  try {
    const c = decryptSecret(account.credentials) as { token?: string; clientToken?: string };
    if (!c.token) return null;
    return { instanceId: instanceIdOf(account.phoneNumberId), token: c.token, clientToken: c.clientToken || undefined };
  } catch (e) {
    console.error("[zapi] não foi possível decifrar as credenciais:", (e as Error).message);
    return null;
  }
}

const url = (c: ZapiCredentials, path: string) => `${ZAPI_BASE}/instances/${encodeURIComponent(c.instanceId)}/token/${encodeURIComponent(c.token)}/${path}`;
const headers = (c: ZapiCredentials): Record<string, string> => ({ "Content-Type": "application/json", ...(c.clientToken ? { "Client-Token": c.clientToken } : {}) });

async function call(c: ZapiCredentials, path: string, init: { method?: string; body?: unknown } = {}, fetchImpl: FetchLike = fetch as any): Promise<any> {
  let r: any;
  try {
    r = await fetchImpl(url(c, path), {
      method: init.method ?? "GET",
      headers: headers(c),
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw new ZapiError("REDE", `Não foi possível falar com a Z-API: ${(e as Error).message}`);
  }
  const text = await r.text?.().catch?.(() => "") ?? "";
  let j: any = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    j = text; // alguns endpoints (QR code) podem devolver texto puro
  }
  if (!r.ok) {
    const msg = typeof j === "object" && j ? j.error || j.message || JSON.stringify(j) : String(j || `HTTP ${r.status}`);
    throw new ZapiError("ZAPI", `Z-API recusou (${r.status}): ${msg}`.slice(0, 300));
  }
  return j;
}

export interface ZapiStatus {
  connected: boolean;
  smartphoneConnected: boolean;
  error: string | null;
}

export async function zapiStatus(c: ZapiCredentials, f?: FetchLike): Promise<ZapiStatus> {
  const j = await call(c, "status", {}, f);
  return { connected: j?.connected === true, smartphoneConnected: j?.smartphoneConnected === true, error: j?.error ? String(j.error) : null };
}

/** Telefone do celular conectado (`/device`); null se ainda não conectou. */
export async function zapiDevice(c: ZapiCredentials, f?: FetchLike): Promise<{ phone: string | null; name: string | null }> {
  const j = await call(c, "device", {}, f);
  return { phone: j?.phone ? String(j.phone) : null, name: j?.name ? String(j.name) : null };
}

/** QR code para parear (vale ~20 s). Devolve um data URL pronto para <img>; aceita JSON {value} ou texto puro. */
export async function zapiQrImage(c: ZapiCredentials, f?: FetchLike): Promise<string> {
  const j = await call(c, "qr-code/image", {}, f);
  const raw = typeof j === "string" ? j : String(j?.value ?? j?.image ?? "");
  if (!raw) throw new ZapiError("ZAPI", "A Z-API não devolveu o QR code (o número pode já estar conectado).");
  return raw.startsWith("data:") ? raw : `data:image/png;base64,${raw}`;
}

/** Aponta TODOS os webhooks da instância para a nossa URL (só HTTPS). Recebe mensagens e status. */
export async function zapiSetWebhooks(c: ZapiCredentials, webhookUrl: string, f?: FetchLike): Promise<void> {
  if (!/^https:\/\//i.test(webhookUrl)) throw new ZapiError("ZAPI", "A Z-API só aceita webhook em HTTPS.");
  await call(c, "update-every-webhooks", { method: "PUT", body: { value: webhookUrl, notifySentByMe: false } }, f);
}

/** Telefone para a Z-API: só dígitos com DDI (55 + DDD + número). */
export function zapiPhone(to: string): string {
  const d = String(to).replace(/\D/g, "");
  return d.length <= 11 ? `55${d}` : d;
}

/** Envia texto livre; devolve o id da mensagem (guardar: serve para status e resposta). */
export async function zapiSendText(c: ZapiCredentials, to: string, message: string, opts: { delayMessage?: number } = {}, f?: FetchLike): Promise<string> {
  const j = await call(c, "send-text", { method: "POST", body: { phone: zapiPhone(to), message, ...(opts.delayMessage ? { delayMessage: opts.delayMessage } : {}) } }, f);
  const id = j?.messageId ?? j?.id ?? j?.zaapId;
  if (!id) throw new ZapiError("ZAPI", "A Z-API não devolveu o id da mensagem.");
  return String(id);
}

// ───────────────────────── webhooks recebidos ─────────────────────────

export type ZapiEvent =
  | { kind: "message"; message: InboundMessage & { mediaUrl: string | null } }
  | { kind: "status"; ids: string[]; status: string }
  | { kind: "ignore"; motivo: string };

const MEDIA = ["image", "audio", "video", "document", "sticker"] as const;

/**
 * Lê o corpo do webhook. Só mensagens RECEBIDAS de contato individual viram mensagem (ignora grupo, canal,
 * resposta a status do WhatsApp, o que enviamos nós mesmos e edição). `ids`/`status` de MessageStatusCallback
 * viram atualização de entrega (SENT/RECEIVED/READ).
 */
export function parseZapiWebhook(body: any, instanceId: string): ZapiEvent {
  if (!body || typeof body !== "object") return { kind: "ignore", motivo: "corpo vazio" };
  if (body.instanceId && String(body.instanceId) !== instanceId) return { kind: "ignore", motivo: "outra instância" };

  if (body.type === "MessageStatusCallback") {
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    return ids.length && body.status ? { kind: "status", ids, status: String(body.status) } : { kind: "ignore", motivo: "status sem id" };
  }
  if (body.type !== "ReceivedCallback") return { kind: "ignore", motivo: `evento ${body.type ?? "desconhecido"}` };
  if (body.fromMe) return { kind: "ignore", motivo: "enviada por nós" };
  if (body.isGroup || body.isNewsletter) return { kind: "ignore", motivo: "grupo/canal" };
  if (body.isStatusReply || body.isEdit || body.waitingMessage) return { kind: "ignore", motivo: "não é mensagem nova" };
  const waId = String(body.phone ?? "").replace(/\D/g, "");
  if (!waId || !body.messageId) return { kind: "ignore", motivo: "sem telefone ou id" };

  let type = "unknown";
  let text: string | null = null;
  let mediaUrl: string | null = null;
  let mime: string | null = null;
  let filename: string | null = null;
  if (body.text?.message !== undefined) {
    type = "text";
    text = String(body.text.message);
  } else {
    const t = MEDIA.find((m) => body[m]);
    if (t) {
      const m = body[t];
      type = t;
      text = m.caption ?? null;
      mediaUrl = m[`${t}Url`] ?? m.url ?? null;
      mime = m.mimeType ?? null;
      filename = m.fileName ?? null;
    } else if (body.reaction) {
      return { kind: "ignore", motivo: "reação" };
    } else if (body.location) {
      type = "location";
      text = "📍 Localização";
    } else if (body.contact) {
      type = "contacts";
    }
  }

  const ts = Number(body.momment);
  return {
    kind: "message",
    message: {
      phoneNumberId: zapiAccountKey(instanceId),
      waId,
      contactName: body.senderName || body.chatName || null,
      wamid: String(body.messageId),
      timestamp: Number.isFinite(ts) && ts > 0 ? new Date(ts) : new Date(),
      type,
      body: text,
      mediaId: mediaUrl ? "zapi" : null, // marcador: o arquivo é baixado na hora e guardado em WaMediaBlob
      mediaMime: mime,
      mediaFilename: filename,
      mediaUrl,
    },
  };
}

/** Status de entrega da Z-API → o nosso (sent | delivered | read). */
export function zapiStatusToOurs(s: string): "sent" | "delivered" | "read" | null {
  switch (String(s).toUpperCase()) {
    case "SENT": return "sent";
    case "RECEIVED": return "delivered";
    case "READ":
    case "PLAYED": return "read";
    default: return null;
  }
}

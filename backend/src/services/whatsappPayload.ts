/**
 * Funções puras (sem banco nem Express) para o webhook do WhatsApp Cloud API: leitura do payload,
 * variações do telefone brasileiro e detecção de pedido de opt-out. A gravação fica em
 * whatsappInbox.ts. Formato do payload (campo `messages` do webhook da Meta):
 *   entry[].changes[].value = { metadata: { phone_number_id }, contacts: [{ wa_id, profile: { name } }],
 *                               messages: [...], statuses: [...] }
 */

export interface InboundMessage {
  phoneNumberId: string;
  waId: string;
  contactName: string | null;
  wamid: string;
  timestamp: Date;
  type: string;
  body: string | null;
  mediaId: string | null;
  mediaMime: string | null;
  mediaFilename: string | null;
}

export interface StatusUpdate {
  phoneNumberId: string;
  wamid: string;
  status: string; // sent | delivered | read | failed
  timestamp: Date | null;
  errorText: string | null;
}

export interface ParsedWebhook {
  messages: InboundMessage[];
  statuses: StatusUpdate[];
}

const MEDIA_TYPES = ["image", "audio", "video", "document", "sticker"] as const;

const tsToDate = (ts: unknown): Date => {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
};

function describeMessage(m: any): Pick<InboundMessage, "type" | "body" | "mediaId" | "mediaMime" | "mediaFilename"> {
  const type = String(m?.type ?? "unknown");
  const none = { mediaId: null, mediaMime: null, mediaFilename: null };

  if (type === "text") return { type, body: m.text?.body ?? null, ...none };

  if ((MEDIA_TYPES as readonly string[]).includes(type)) {
    const media = m[type] ?? {};
    return {
      type,
      body: media.caption ?? null,
      mediaId: media.id ?? null,
      mediaMime: media.mime_type ?? null,
      mediaFilename: media.filename ?? null,
    };
  }

  if (type === "location") {
    const l = m.location ?? {};
    const nome = [l.name, l.address].filter(Boolean).join(" · ");
    return { type, body: `Localização${nome ? `: ${nome}` : ""} (${l.latitude}, ${l.longitude})`, ...none };
  }

  if (type === "contacts") return { type, body: "Contato compartilhado", ...none };

  // Resposta a botão de template (quick reply) e a mensagens interativas (botões/listas).
  if (type === "button") return { type, body: m.button?.text ?? m.button?.payload ?? null, ...none };
  if (type === "interactive") {
    const i = m.interactive ?? {};
    return { type, body: i.button_reply?.title ?? i.list_reply?.title ?? null, ...none };
  }

  if (type === "reaction") return { type, body: m.reaction?.emoji ?? null, ...none };

  // unsupported, system, order, ... — guarda o registro sem inventar conteúdo.
  return { type, body: type === "unsupported" ? "Mensagem não suportada pelo WhatsApp Business API" : null, ...none };
}

export function parseWebhookPayload(body: any): ParsedWebhook {
  const out: ParsedWebhook = { messages: [], statuses: [] };
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      if (!value) continue;
      const phoneNumberId = String(value.metadata?.phone_number_id ?? "");
      const names = new Map<string, string>();
      for (const c of value.contacts ?? []) {
        if (c?.wa_id && c?.profile?.name) names.set(String(c.wa_id), String(c.profile.name));
      }

      for (const m of value.messages ?? []) {
        if (!m?.id || !m?.from) continue;
        const waId = String(m.from);
        out.messages.push({
          phoneNumberId,
          waId,
          contactName: names.get(waId) ?? null,
          wamid: String(m.id),
          timestamp: tsToDate(m.timestamp),
          ...describeMessage(m),
        });
      }

      for (const s of value.statuses ?? []) {
        if (!s?.id) continue;
        const err = s.errors?.[0];
        out.statuses.push({
          phoneNumberId,
          wamid: String(s.id),
          status: String(s.status ?? ""),
          timestamp: s.timestamp ? tsToDate(s.timestamp) : null,
          errorText: err ? `${err.code ?? ""} ${err.title ?? err.message ?? ""}`.trim() : null,
        });
      }
    }
  }
  return out;
}

/**
 * Telefones (E.164, como em Client.telefone) que o `wa_id` pode representar. No Brasil a Meta às
 * vezes informa o número SEM o nono dígito dos celulares (55 + DDD + 8 dígitos), enquanto a base
 * tem o número com 9 — e o contrário também acontece. Devolve as duas formas.
 */
export function phoneCandidates(waId: string): string[] {
  const digits = (waId || "").replace(/\D/g, "");
  if (!digits) return [];
  const out = new Set<string>([`+${digits}`]);
  if (digits.startsWith("55")) {
    const rest = digits.slice(2); // DDD + número
    if (rest.length === 10 && /^[6-9]/.test(rest.slice(2))) out.add(`+55${rest.slice(0, 2)}9${rest.slice(2)}`);
    if (rest.length === 11 && rest[2] === "9") out.add(`+55${rest.slice(0, 2)}${rest.slice(3)}`);
  }
  return [...out];
}

const OPT_OUT_FIRST_WORDS = new Set(["parar", "pare", "sair", "stop", "cancelar", "cancela", "descadastrar", "remover", "unsubscribe"]);
const OPT_OUT_PHRASES = new Set([
  "nao quero receber",
  "nao quero mais receber",
  "nao quero receber mensagens",
  "nao quero mais mensagens",
  "nao me envie mais",
  "nao envie mais mensagens",
]);

/** minúsculas, sem acento, sem pontuação, espaços colapsados */
export function normalizeText(text: string): string {
  return (text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pedido de opt-out: mensagem curta que começa com PARAR/SAIR/STOP/CANCELAR... (até 4 palavras,
 * para não tratar "quero sair do aperto financeiro" como descadastro) ou uma frase clara de recusa.
 */
export function isOptOutMessage(text: string | null | undefined): boolean {
  const t = normalizeText(text ?? "");
  if (!t) return false;
  if (OPT_OUT_PHRASES.has(t)) return true;
  const words = t.split(" ");
  return words.length <= 4 && OPT_OUT_FIRST_WORDS.has(words[0]);
}

/** Texto curto para a lista de conversas. */
export function previewOf(m: { type: string; body: string | null }): string {
  const label: Record<string, string> = {
    image: "📷 Imagem",
    audio: "🎤 Áudio",
    video: "🎬 Vídeo",
    document: "📄 Documento",
    sticker: "Figurinha",
    location: "📍 Localização",
    contacts: "👤 Contato",
  };
  const base = label[m.type];
  const text = (m.body ?? "").replace(/\s+/g, " ").trim();
  if (base) return text ? `${base}: ${text}`.slice(0, 140) : base;
  return (text || "Mensagem").slice(0, 140);
}

/** A janela de atendimento de 24 horas da Meta, contada a partir da última mensagem do cliente. */
export const JANELA_HORAS = 24;
export function janelaAte(lastInboundAt: Date | null | undefined): Date | null {
  return lastInboundAt ? new Date(lastInboundAt.getTime() + JANELA_HORAS * 3600_000) : null;
}

export interface TemplateEvent {
  wabaId: string;
  kind: "status" | "quality" | "category";
  metaTemplateId: string | null;
  name: string | null;
  language: string | null;
  status?: string; // APPROVED | REJECTED | PAUSED | DISABLED | PENDING ...
  reason?: string | null;
  quality?: string; // GREEN | YELLOW | RED | UNKNOWN
  category?: string;
}

/** Eventos de template do webhook (campos message_template_status_update, ..._quality_update e template_category_update). */
export function parseTemplateEvents(body: any): TemplateEvent[] {
  const out: TemplateEvent[] = [];
  for (const entry of body?.entry ?? []) {
    const wabaId = String(entry?.id ?? "");
    for (const change of entry?.changes ?? []) {
      const v = change?.value ?? {};
      const base = {
        wabaId,
        metaTemplateId: v.message_template_id != null ? String(v.message_template_id) : null,
        name: v.message_template_name ?? null,
        language: v.message_template_language ?? null,
      };
      if (change?.field === "message_template_status_update" && v.event) {
        out.push({ ...base, kind: "status", status: String(v.event).toUpperCase(), reason: v.reason ?? null });
      } else if (change?.field === "message_template_quality_update" && v.new_quality_score) {
        out.push({ ...base, kind: "quality", quality: String(v.new_quality_score).toUpperCase() });
      } else if (change?.field === "template_category_update" && v.new_category) {
        out.push({ ...base, kind: "category", category: String(v.new_category).toUpperCase() });
      }
    }
  }
  return out;
}

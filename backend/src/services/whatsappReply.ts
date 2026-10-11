import { AppPrismaClient } from "../config/db";
import { baseMime } from "./whatsappMedia";
import {
  assertJanelaAberta,
  mediaTypeForMime,
  OUTBOUND_MAX_BYTES,
  SendError,
  sendMedia,
  sendText,
  TEXT_MAX_CHARS,
  uploadMedia,
} from "./whatsappSend";
import { previewOf } from "./whatsappPayload";

/**
 * Responde a um cliente dentro de uma conversa: confere a janela de 24 horas, envia pela Meta e só
 * então grava a mensagem de saída (nunca registra como enviado o que a Meta recusou).
 */
export type ReplyInput =
  | { tipo: "text"; texto: string }
  | { tipo: "arquivo"; nome: string; mime: string; data: Buffer; legenda?: string };

export interface ReplyDeps {
  fetchImpl?: any;
  token?: string;
  now?: Date;
}

export async function sendReply(
  prisma: AppPrismaClient,
  tenantId: string,
  userId: string,
  conversationId: string,
  input: ReplyInput,
  deps: ReplyDeps = {}
) {
  const token = deps.token ?? process.env.WHATSAPP_ACCESS_TOKEN;
  const now = deps.now ?? new Date();

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
    include: { account: { select: { phoneNumberId: true, active: true } } },
  });
  if (!conversation) throw new SendError("NAO_ENCONTRADA", "Conversa não encontrada.");
  assertJanelaAberta(conversation.lastInboundAt, now);
  if (!conversation.account.active) throw new SendError("META", "O número do WhatsApp desta conversa está desativado.");

  const phoneNumberId = conversation.account.phoneNumberId;
  let wamid: string;
  let row: { type: string; body: string | null; mediaId: string | null; mediaMime: string | null; mediaFilename: string | null };
  let blob: { mime: string; data: Buffer } | null = null;

  if (input.tipo === "text") {
    const texto = input.texto.trim();
    if (!texto) throw new SendError("TIPO_INVALIDO", "Escreva uma mensagem.");
    if (texto.length > TEXT_MAX_CHARS) throw new SendError("TIPO_INVALIDO", `A mensagem passa de ${TEXT_MAX_CHARS} caracteres.`);
    wamid = await sendText(phoneNumberId, token, conversation.waId, texto, deps.fetchImpl);
    row = { type: "text", body: texto, mediaId: null, mediaMime: null, mediaFilename: null };
  } else {
    const mime = baseMime(input.mime);
    const tipo = mediaTypeForMime(mime);
    if (!tipo) throw new SendError("TIPO_INVALIDO", "Formato não aceito. Envie imagem JPG/PNG, PDF, áudio (OGG, MP3, M4A, AAC, AMR) ou vídeo MP4.");
    if (input.data.length === 0) throw new SendError("TIPO_INVALIDO", "Arquivo vazio.");
    if (input.data.length > OUTBOUND_MAX_BYTES) throw new SendError("MUITO_GRANDE", `Arquivo maior que ${OUTBOUND_MAX_BYTES / 1048576} MB.`);
    const nome = input.nome.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "arquivo";
    const legenda = input.legenda?.trim() || undefined;
    const mediaId = await uploadMedia(phoneNumberId, token, input.data, mime, nome, deps.fetchImpl);
    wamid = await sendMedia(phoneNumberId, token, conversation.waId, tipo, mediaId, { caption: legenda, filename: nome }, deps.fetchImpl);
    row = { type: tipo, body: tipo === "audio" ? null : legenda ?? null, mediaId, mediaMime: mime, mediaFilename: nome };
    blob = { mime, data: input.data };
  }

  const message = await prisma.waMessage.create({
    data: { tenantId, conversationId: conversation.id, direction: "SAIDA", wamid, status: "sent", sentByUserId: userId, timestamp: now, ...row },
  });
  // A cópia local permite mostrar o arquivo enviado sem baixá-lo de volta da Meta.
  if (blob) {
    await prisma.waMediaBlob
      .create({ data: { tenantId, messageId: message.id, mime: blob.mime, size: blob.data.length, data: blob.data } })
      .catch(() => undefined);
  }
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: now, lastPreview: `Você: ${previewOf(row)}`.slice(0, 140) },
  });
  return message;
}

/** Ordem dos status de entrega: nunca volta de "lida" para "entregue" se o webhook chegar fora de ordem. */
const RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3 };

export function nextOutboundStatus(current: string | null | undefined, incoming: string): string | null {
  if (incoming === "failed") return "failed";
  if (!(incoming in RANK)) return null;
  if (current === "failed") return incoming; // a Meta pode corrigir uma falha transitória
  return (RANK[current ?? ""] ?? 0) >= RANK[incoming] ? null : incoming;
}

/** Aplica o status de entrega (webhook `statuses`) a uma mensagem de SAÍDA, no contexto do tenant. */
export async function applyOutboundStatus(
  prisma: AppPrismaClient,
  tenantId: string,
  st: { wamid: string; status: string; errorText: string | null }
): Promise<boolean> {
  const msg = await prisma.waMessage.findFirst({ where: { tenantId, wamid: st.wamid, direction: "SAIDA" }, select: { id: true, status: true } });
  if (!msg) return false; // status de campanha ou mensagem desconhecida
  const next = nextOutboundStatus(msg.status, st.status);
  if (!next) return false;
  await prisma.waMessage.update({ where: { id: msg.id }, data: { status: next, errorText: next === "failed" ? st.errorText ?? "Falha na entrega" : null } });
  return true;
}

import { AppPrismaClient } from "../config/db";
import { credentialsOf } from "./whatsappAccount";
import { zapiCredentialsOf, zapiSendText, ZapiError } from "./zapi";
import { baseMime } from "./whatsappMedia";
import {
  assertJanelaAberta,
  janelaAberta,
  mediaTypeForMime,
  OUTBOUND_MAX_BYTES,
  SendError,
  sendMedia,
  sendText,
  TEXT_MAX_CHARS,
  uploadMedia,
} from "./whatsappSend";
import { previewOf } from "./whatsappPayload";
import { estaSuprimido, motivoBloqueioCliente, textoSupressao } from "./privacy";
import { motivoSemBaseLegal } from "./baseLegal";
import { templateContext } from "./messageContext";
import { sendTemplateMessage, templateParams, templatePreview } from "./whatsappTemplates";
import { unmappedPositions } from "./templateImport";
import { makeToken, trackedButtons } from "./trackedLinks";

/**
 * Responde a um cliente dentro de uma conversa: confere a janela de 24 horas, envia pela Meta e só
 * então grava a mensagem de saída (nunca registra como enviado o que a Meta recusou).
 *
 * Regra de opt-out na Inbox (LGPD 02-03 / 02-06):
 *  - TEXTO LIVRE (Meta ou Z-API) só sai dentro das 24 h seguintes a uma mensagem do PRÓPRIO titular
 *    (`assertJanelaAberta`). Aí vale mesmo para quem pediu para parar: é atendimento a quem acabou de
 *    escrever (inclusive confirmar o descadastro), não marketing. Fora da janela nada sai em texto livre.
 *  - TEMPLATE (o único jeito de falar primeiro, fora da janela) é contato proativo: bloqueado para cliente
 *    em opt-out/sem autorização/com tratamento bloqueado e para telefone/documento suprimido, também quando
 *    a conversa não está ligada a um cliente (contato de lista manual).
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
  const now = deps.now ?? new Date();

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
    include: { account: { select: { tenantId: true, phoneNumberId: true, active: true, credentials: true, provider: true } } },
  });
  if (!conversation) throw new SendError("NAO_ENCONTRADA", "Conversa não encontrada.");
  if (!conversation.account.active) throw new SendError("META", "O número do WhatsApp desta conversa está desativado.");

  // Conversa que veio pela Z-API (não oficial): responde pela própria Z-API, só texto. LGPD 02-06: com a MESMA
  // janela de 24 h da Meta (antes era "a qualquer tempo", o que abria contato proativo a quem pediu para parar).
  if (conversation.account.provider === "ZAPI") {
    if (!janelaAberta(conversation.lastInboundAt, now)) {
      throw new SendError("JANELA_FECHADA", "A janela de 24 horas está fechada: pela Z-API só dá para responder a quem escreveu nas últimas 24 horas (não há template).");
    }
    return sendZapiReply(prisma, tenantId, userId, conversation, input, deps, now);
  }

  const token = deps.token ?? credentialsOf(conversation.account).accessToken;
  assertJanelaAberta(conversation.lastInboundAt, now);
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

async function sendZapiReply(
  prisma: AppPrismaClient,
  tenantId: string,
  userId: string,
  conversation: { id: string; waId: string; account: { phoneNumberId: string; credentials: unknown } },
  input: ReplyInput,
  deps: ReplyDeps,
  now: Date
) {
  if (input.tipo !== "text") throw new SendError("TIPO_INVALIDO", "Pela Z-API só dá para enviar texto por enquanto (anexos ainda não).");
  const texto = input.texto.trim();
  if (!texto) throw new SendError("TIPO_INVALIDO", "Escreva uma mensagem.");
  if (texto.length > TEXT_MAX_CHARS) throw new SendError("TIPO_INVALIDO", `A mensagem passa de ${TEXT_MAX_CHARS} caracteres.`);
  const creds = zapiCredentialsOf(conversation.account);
  if (!creds) throw new SendError("SEM_TOKEN", "Credenciais da Z-API não configuradas (Configurações > WhatsApp).");
  let wamid: string;
  try {
    wamid = await zapiSendText(creds, conversation.waId, texto, {}, deps.fetchImpl);
  } catch (e) {
    throw new SendError("META", e instanceof ZapiError ? e.message : `Falha ao enviar pela Z-API: ${(e as Error).message}`);
  }
  const message = await prisma.waMessage.create({
    data: { tenantId, conversationId: conversation.id, direction: "SAIDA", wamid, type: "text", body: texto, status: "sent", sentByUserId: userId, timestamp: now },
  });
  await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: now, lastPreview: `Você: ${texto}`.slice(0, 140) } });
  return message;
}

/**
 * LGPD 02-03 / 02-06: contato PROATIVO (template, fora da janela de atendimento) só para quem não pediu para
 * parar. Confere o cadastro do cliente ligado à conversa E a supressão pelo telefone da conversa (e pelo
 * documento do cliente), o que cobre contato de lista sem cliente e o mesmo número em outro cadastro.
 */
export async function assertContatoProativoPermitido(
  prisma: AppPrismaClient,
  tenantId: string,
  conversation: { waId: string; client?: { autorizacaoComunicacao?: boolean | null; optOutAt?: Date | null; bloqueadoLgpdAt?: Date | null; cpfHash?: string | null } | null }
): Promise<void> {
  const doCliente = motivoBloqueioCliente(conversation.client);
  if (doCliente) throw new SendError("OPT_OUT", `${doCliente}: o envio de template está bloqueado.`);
  const motivo = await estaSuprimido(prisma, tenantId, { telefone: conversation.waId, docHash: conversation.client?.cpfHash ?? null });
  if (motivo) throw new SendError("OPT_OUT", `${textoSupressao(motivo)}: o envio de template está bloqueado.`);
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

/** Template da Meta que pode ser enviado agora (aprovado de verdade, não só marcado como aprovado). */
export function isSendableTemplate(t: {
  channel: string;
  status: string;
  metaName: string | null;
  metaStatus: string | null;
  sendIssue?: string | null;
  variableMap?: unknown;
}): boolean {
  return (
    t.channel === "WHATSAPP" &&
    t.status === "APROVADO" &&
    !!t.metaName &&
    t.metaStatus === "APPROVED" &&
    !t.sendIssue &&
    unmappedPositions(t.variableMap as (string | null)[] | null).length === 0
  );
}

/** Variáveis do template para esta conversa: dados do cliente, ou só o nome do perfil se ele não está na base. */
export function conversationContext(conversation: { contactName: string | null; client: any | null }): Record<string, unknown> {
  if (conversation.client) return templateContext(conversation.client);
  return { nome: conversation.contactName ?? "" };
}

export function previewTemplateFor(template: { body: string; metaBody?: string | null; variableMap?: unknown }, conversation: { contactName: string | null; client: any | null }) {
  const params = templateParams(template, conversationContext(conversation));
  return { params, texto: templatePreview(template, params) };
}

/**
 * Envia um template aprovado numa conversa — o jeito de falar com o cliente FORA da janela de 24h.
 * Quem pediu para parar (opt-out) não recebe template, mesmo que a janela esteja fechada.
 */
export async function sendTemplateReply(
  prisma: AppPrismaClient,
  tenantId: string,
  userId: string,
  conversationId: string,
  templateId: string,
  deps: ReplyDeps = {}
) {
  const now = deps.now ?? new Date();
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
    include: { account: { select: { tenantId: true, phoneNumberId: true, active: true, credentials: true, provider: true } }, client: true },
  });
  if (!conversation) throw new SendError("NAO_ENCONTRADA", "Conversa não encontrada.");
  if (conversation.account.provider === "ZAPI") throw new SendError("TEMPLATE_INDISPONIVEL", "Conversas pela Z-API não usam template: responda em texto.");
  if (!conversation.account.active) throw new SendError("META", "O número do WhatsApp desta conversa está desativado.");
  const token = deps.token ?? credentialsOf(conversation.account).accessToken;
  await assertContatoProativoPermitido(prisma, tenantId, conversation);

  const template = await prisma.messageTemplate.findFirst({ where: { id: templateId, tenantId } });
  if (!template || !isSendableTemplate(template)) throw new SendError("TEMPLATE_INDISPONIVEL", "Este template não está aprovado pela Meta.");
  // LGPD 02-01: template de marketing é contato proativo, com a mesma trava de base legal das campanhas
  if (template.category !== "UTILITY") {
    const semBase = motivoSemBaseLegal(await prisma.tenant.findUnique({ where: { id: tenantId }, select: { baseLegalMarketing: true } }));
    if (semBase) throw new SendError("TEMPLATE_INDISPONIVEL", semBase);
  }

  const { params, texto } = previewTemplateFor(template, conversation);
  let headerImageId: string | undefined;
  if (template.headerFormat === "IMAGE") {
    const media = await prisma.templateMedia.findFirst({ where: { templateId: template.id, tenantId } });
    if (!media) throw new SendError("TEMPLATE_INDISPONIVEL", "Este template precisa da imagem do cabeçalho (Templates).");
    headerImageId = await uploadMedia(conversation.account.phoneNumberId, token, Buffer.from(media.data), media.mime, media.filename, deps.fetchImpl);
  }
  const wamid = await sendTemplateMessage(conversation.account.phoneNumberId, token, conversation.waId, template.metaName!, template.language, params, deps.fetchImpl, headerImageId, trackedButtons(template).map((b) => ({ index: b.index, token: makeToken("n", template.id, b.index) })));
  const message = await prisma.waMessage.create({
    data: { tenantId, conversationId: conversation.id, direction: "SAIDA", wamid, type: "template", body: texto, status: "sent", sentByUserId: userId, timestamp: now },
  });
  await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: now, lastPreview: `Você: ${texto}`.slice(0, 140) } });
  return message;
}

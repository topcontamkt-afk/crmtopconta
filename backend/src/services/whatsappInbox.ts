import { Prisma } from "@prisma/client";
import { AppPrismaClient } from "../config/db";
import { logAudit } from "../middleware/audit";
import { InboundMessage, isOptOutMessage, phoneCandidates, previewOf } from "./whatsappPayload";

/**
 * Grava uma mensagem recebida do cliente: acha (ou cria) a conversa, liga ao cliente pelo telefone,
 * guarda a mensagem (idempotente pelo `wamid`), marca a mensagem de campanha como respondida e
 * trata o pedido de opt-out. Roda DENTRO do contexto do tenant dono do número (o webhook resolve o
 * tenant pelo phone_number_id e chama isto via runWithTenantContextAsync).
 */
export interface StoreResult {
  stored: boolean; // false = mensagem duplicada (a Meta reenviou o webhook)
  messageId: string | null;
  conversationId: string;
  clientId: string | null;
  optedOut: boolean;
}

/**
 * O Brasil tem o "nono dígito": a mesma pessoa pode aparecer como 5584999998888 ou 558499998888.
 * Se já existe conversa com qualquer uma das formas, usa a dela em vez de abrir uma segunda.
 */
async function resolveWaId(prisma: AppPrismaClient, tenantId: string, accountId: string, waId: string): Promise<string> {
  const variants = phoneCandidates(waId).map((p) => p.replace("+", ""));
  const existing = await prisma.conversation.findFirst({ where: { tenantId, accountId, waId: { in: variants } }, select: { waId: true } });
  return existing?.waId ?? waId;
}

/** Guarda na conversa a mensagem de campanha (template) enviada ao cliente. Melhor esforço. */
export async function recordOutboundTemplateMessage(
  prisma: AppPrismaClient,
  tenantId: string,
  client: { id: string | null; telefone: string; nome?: string },
  wamid: string,
  renderedBody: string
): Promise<void> {
  const account = await prisma.whatsAppAccount.findFirst({ where: { tenantId, active: true, provider: "META" }, orderBy: { createdAt: "asc" } });
  if (!account) return;
  const digits = client.telefone.replace(/\D/g, "");
  if (!digits) return;
  const waId = await resolveWaId(prisma, tenantId, account.id, digits);
  const now = new Date();
  const conversation = await prisma.conversation.upsert({
    where: { accountId_waId: { accountId: account.id, waId } },
    create: { tenantId, accountId: account.id, waId, clientId: client.id, contactName: client.id ? undefined : client.nome, lastMessageAt: now, lastPreview: `Campanha: ${renderedBody}`.slice(0, 140) },
    update: { ...(client.id ? { clientId: client.id } : {}), lastMessageAt: now, lastPreview: `Campanha: ${renderedBody}`.slice(0, 140) },
  });
  await prisma.waMessage
    .create({ data: { tenantId, conversationId: conversation.id, direction: "SAIDA", wamid, type: "template", body: renderedBody, status: "sent", timestamp: now } })
    .catch(() => undefined);
}

const OPEN_STATUSES = ["ENVIADO", "ENTREGUE", "LIDO"] as const;
const RESPONSE_WINDOW_DAYS = 7;

export async function storeInboundMessage(
  prisma: AppPrismaClient,
  tenantId: string,
  accountId: string,
  m: InboundMessage
): Promise<StoreResult> {
  // 1) cliente pelo telefone (variações do nono dígito)
  const candidates = phoneCandidates(m.waId);
  const client = candidates.length
    ? await prisma.client.findFirst({
        where: { tenantId, telefone: { in: candidates } },
        orderBy: { updatedAt: "desc" },
        select: { id: true, nome: true },
      })
    : null;

  // 2) conversa (uma por número nosso + número do cliente; reaproveita a que já existe com o outro formato do telefone)
  const waId = await resolveWaId(prisma, tenantId, accountId, m.waId);
  const conversation = await prisma.conversation.upsert({
    where: { accountId_waId: { accountId, waId } },
    create: {
      tenantId,
      accountId,
      waId,
      clientId: client?.id ?? null,
      contactName: m.contactName,
      lastMessageAt: m.timestamp,
      lastInboundAt: m.timestamp,
      lastPreview: previewOf(m),
    },
    update: {
      ...(m.contactName ? { contactName: m.contactName } : {}),
      ...(client ? { clientId: client.id } : {}),
    },
  });

  // 3) mensagem — duplicata (mesmo wamid) não conta de novo
  let messageId: string | null = null;
  try {
    const created = await prisma.waMessage.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        direction: "ENTRADA",
        wamid: m.wamid,
        type: m.type,
        body: m.body,
        mediaId: m.mediaId,
        mediaMime: m.mediaMime,
        mediaFilename: m.mediaFilename,
        timestamp: m.timestamp,
      },
    });
    messageId = created.id;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { stored: false, messageId: null, conversationId: conversation.id, clientId: conversation.clientId, optedOut: false };
    }
    throw e;
  }

  // 4) atualiza o resumo da conversa só se esta for a mensagem mais recente
  const maisRecente = !conversation.lastInboundAt || m.timestamp >= conversation.lastInboundAt;
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      unreadCount: { increment: 1 },
      status: "ABERTA",
      ...(maisRecente ? { lastMessageAt: m.timestamp, lastInboundAt: m.timestamp, lastPreview: previewOf(m) } : {}),
    },
  });

  // 5) resposta a uma campanha: marca a última mensagem enviada a esse cliente como respondida
  if (client) {
    const desde = new Date(Date.now() - RESPONSE_WINDOW_DAYS * 86_400_000);
    const evento = await prisma.messageEvent.findFirst({
      where: { clientId: client.id, channel: "WHATSAPP", status: { in: [...OPEN_STATUSES] }, sentAt: { gte: desde }, campaign: { tenantId } },
      orderBy: { sentAt: "desc" },
      select: { id: true },
    });
    if (evento) {
      await prisma.messageEvent.update({ where: { id: evento.id }, data: { status: "RESPONDIDO", respondedAt: m.timestamp } });
    }
  }

  // 5b) contato de lista manual que não é cliente: a resposta também conta na campanha dele
  if (!client && candidates.length) {
    const desde = new Date(Date.now() - RESPONSE_WINDOW_DAYS * 86_400_000);
    const evento = await prisma.messageEvent.findFirst({
      where: { recipient: { tenantId, telefone: { in: candidates } }, channel: "WHATSAPP", status: { in: [...OPEN_STATUSES] }, sentAt: { gte: desde } },
      orderBy: { sentAt: "desc" },
      select: { id: true },
    });
    if (evento) await prisma.messageEvent.update({ where: { id: evento.id }, data: { status: "RESPONDIDO", respondedAt: m.timestamp } });
  }

  // 6) pedido de descadastro (LGPD): vale na hora e fica no log de auditoria
  let optedOut = false;
  // texto digitado ou toque num botão (ex.: o botão "SAIR" do template)
  if (client && ["text", "button", "interactive"].includes(m.type) && isOptOutMessage(m.body)) {
    await prisma.client.updateMany({
      where: { id: client.id, tenantId },
      data: { autorizacaoComunicacao: false, optOutAt: new Date() },
    });
    await logAudit({
      tenantId,
      action: "OPT_OUT_WHATSAPP",
      target: "Client",
      targetId: client.id,
      details: { conversationId: conversation.id, wamid: m.wamid },
    });
    optedOut = true;
  } else if (!client && candidates.length && ["text", "button", "interactive"].includes(m.type) && isOptOutMessage(m.body)) {
    // Contato fora da base (lista manual): o pedido de descadastro vale para as próximas listas.
    await prisma.campaignRecipient.updateMany({ where: { tenantId, telefone: { in: candidates } }, data: { optOutAt: new Date() } });
    await logAudit({
      tenantId,
      action: "OPT_OUT_WHATSAPP",
      target: "CampaignRecipient",
      details: { conversationId: conversation.id, wamid: m.wamid },
    });
    optedOut = true;
  }

  return { stored: true, messageId, conversationId: conversation.id, clientId: client?.id ?? null, optedOut };
}

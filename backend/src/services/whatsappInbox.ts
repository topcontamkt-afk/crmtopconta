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

  // 2) conversa (uma por número nosso + número do cliente)
  const conversation = await prisma.conversation.upsert({
    where: { accountId_waId: { accountId, waId: m.waId } },
    create: {
      tenantId,
      accountId,
      waId: m.waId,
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

  // 6) pedido de descadastro (LGPD): vale na hora e fica no log de auditoria
  let optedOut = false;
  if (client && m.type === "text" && isOptOutMessage(m.body)) {
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
  }

  return { stored: true, messageId, conversationId: conversation.id, clientId: client?.id ?? null, optedOut };
}

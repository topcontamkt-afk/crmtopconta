import { AppPrismaClient } from "../config/db";
import { credentialsOf } from "./whatsappAccount";
import { SendError, sendText, TEXT_MAX_CHARS } from "./whatsappSend";

/**
 * Resposta automática do número de avisos: quem escreve aqui recebe uma mensagem fixa mandando-o ao
 * suporte. Só vai dentro da janela de 24h que a própria mensagem do cliente acabou de abrir (texto
 * livre) e responde a TODA mensagem do cliente, mas no máximo `AUTO_REPLY_MAX` vezes por conversa em
 * `AUTO_REPLY_JANELA_MS` (24 h corridas; depois disso o cliente é ignorado até a janela andar) e nunca
 * para quem pediu descadastro (PARAR/SAIR). O limite conta as respostas automáticas já gravadas.
 */
export const AUTO_REPLY_PADRAO =
  "Este é um canal apenas para informações. Informamos que não realizamos atendimentos por aqui.\n\n" +
  "Para suporte técnico ou em caso de dúvidas, entre em contato com nossa equipe de suporte: (79) 99837-2540.";

export const AUTO_REPLY_MAX = 3;
export const AUTO_REPLY_JANELA_MS = 24 * 3600_000;

type AccountLike = { autoReplyEnabled?: boolean | null; autoReplyText?: string | null };

/** Texto que será enviado: o da conta, ou o padrão quando está vazio. */
export function autoReplyTextOf(account: AccountLike): string {
  const t = account.autoReplyText?.trim();
  return t ? t.slice(0, TEXT_MAX_CHARS) : AUTO_REPLY_PADRAO;
}

/** Decisão pura: responde a esta mensagem? (a trava por conversa é feita no banco, de forma atômica) */
export function shouldAutoReply(account: AccountLike, r: { stored: boolean; optedOut: boolean }): boolean {
  return account.autoReplyEnabled !== false && r.stored && !r.optedOut;
}

export interface AutoReplyDeps {
  fetchImpl?: any;
  now?: Date;
}

/**
 * Envia a resposta automática. Retorna true se enviou. Melhor esforço: nunca lança (a mensagem do
 * cliente já foi gravada e o webhook não pode falhar por causa disto).
 */
export async function maybeAutoReply(
  prisma: AppPrismaClient,
  tenantId: string,
  account: AccountLike & { id: string; phoneNumberId: string; credentials?: unknown },
  inbound: { stored: boolean; optedOut: boolean; conversationId: string },
  deps: AutoReplyDeps = {}
): Promise<boolean> {
  if (!shouldAutoReply(account, inbound)) return false;
  const now = deps.now ?? new Date();
  try {
    const enviadas = await prisma.waMessage.count({
      where: { tenantId, conversationId: inbound.conversationId, direction: "SAIDA", automatic: true, timestamp: { gte: new Date(now.getTime() - AUTO_REPLY_JANELA_MS) } },
    });
    if (enviadas >= AUTO_REPLY_MAX) return false;

    const conversation = await prisma.conversation.findFirst({ where: { id: inbound.conversationId, tenantId }, select: { id: true, waId: true } });
    if (!conversation) return false;
    const texto = autoReplyTextOf(account);
    try {
      const wamid = await sendText(account.phoneNumberId, credentialsOf(account).accessToken, conversation.waId, texto, deps.fetchImpl);
      await prisma.waMessage.create({
        data: { tenantId, conversationId: conversation.id, direction: "SAIDA", wamid, type: "text", body: texto, status: "sent", automatic: true, timestamp: now },
      });
      // Não mexe em unreadCount: a mensagem do cliente continua "não lida" para a equipe ver.
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: now, lastPreview: `Resposta automática: ${texto}`.slice(0, 140) } });
      return true;
    } catch (e) {
      // Falhou na Meta: nada foi gravado, então não conta no limite e a próxima mensagem tenta de novo.
      console.warn(`[whatsapp/auto-reply] não enviada: ${e instanceof SendError ? e.message : (e as Error).message}`);
      return false;
    }
  } catch (e) {
    console.error("[whatsapp/auto-reply] erro inesperado:", e);
    return false;
  }
}

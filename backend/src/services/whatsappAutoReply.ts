import { AppPrismaClient } from "../config/db";
import { credentialsOf } from "./whatsappAccount";
import { SendError, sendText, TEXT_MAX_CHARS } from "./whatsappSend";

/**
 * Resposta automática do número de avisos: quem escreve aqui recebe uma mensagem dizendo que o canal não é
 * acompanhado, com o contato do controlador (quando configurado) e como parar de receber. Só vai dentro da janela de 24h que a própria mensagem do cliente acabou de abrir (texto
 * livre) e responde a TODA mensagem do cliente, mas no máximo `autoReplyMax` vezes por conversa em
 * `autoReplyJanelaHoras` (padrão 3 por 24 h corridas, configurável na conta; depois disso o cliente é ignorado até a janela andar) e nunca
 * para quem pediu descadastro (PARAR/SAIR). O limite conta as respostas automáticas já gravadas.
 */
/**
 * LGPD 02-08: texto NEUTRO, usado quando a conta não tem texto próprio e o tenant não configurou o controlador
 * (Configurações → LGPD). Sem telefone ou nome de empresa fixo no código: o padrão de um tenant nunca manda o
 * titular para o contato de outro controlador. Sempre ensina a parar.
 */
export const AUTO_REPLY_PADRAO =
  "Este número envia apenas avisos e não acompanha as mensagens recebidas.\n\n" + `Para não receber mais mensagens, responda SAIR.`;

/** Dados do controlador (Tenant) usados no texto padrão. */
export interface ControladorAutoReply {
  name?: string | null;
  controladorNome?: string | null;
  encarregadoNome?: string | null;
  encarregadoContato?: string | null;
}

/**
 * LGPD 02-08 / 03-06: texto padrão a partir da configuração do controlador: quem é (nome do controlador), por onde
 * falar e exercer os direitos sobre os dados (contato do encarregado/canal do titular) e como parar. Sem
 * controlador nem contato configurados, o texto neutro.
 */
export function autoReplyPadraoDo(t: ControladorAutoReply | null | undefined): string {
  const nome = t?.controladorNome?.trim() || "";
  const contato = t?.encarregadoContato?.trim() || "";
  if (!nome && !contato) return AUTO_REPLY_PADRAO;
  const quem = nome ? `Este número de ${nome} envia apenas avisos` : "Este número envia apenas avisos";
  const linhas = [`${quem} e não acompanha as mensagens recebidas.`];
  if (contato) {
    const resp = t?.encarregadoNome?.trim();
    linhas.push(`Para atendimento, dúvidas ou pedidos sobre seus dados pessoais, fale com ${resp ? `${resp}: ` : ""}${contato}.`);
  }
  linhas.push("Para não receber mais mensagens, responda SAIR.");
  return linhas.join("\n\n");
}

export const AUTO_REPLY_MAX = 3;
export const AUTO_REPLY_JANELA_HORAS = 24;
export const AUTO_REPLY_JANELA_MS = AUTO_REPLY_JANELA_HORAS * 3600_000;
/** Tetos aceitos na configuração (evita transformar o canal de avisos em robô de conversa). */
export const AUTO_REPLY_MAX_LIMITE = 10;
export const AUTO_REPLY_JANELA_HORAS_LIMITE = 72;

type AccountLike = { autoReplyEnabled?: boolean | null; autoReplyText?: string | null; autoReplyMax?: number | null; autoReplyJanelaHoras?: number | null };

/** Limites da conta; coluna vazia ou fora da faixa cai no padrão (3 por 24 h). */
export function autoReplyLimitesOf(account: AccountLike): { max: number; janelaHoras: number; janelaMs: number } {
  const max = Number.isInteger(account.autoReplyMax) && account.autoReplyMax! >= 1 && account.autoReplyMax! <= AUTO_REPLY_MAX_LIMITE ? account.autoReplyMax! : AUTO_REPLY_MAX;
  const janelaHoras =
    Number.isInteger(account.autoReplyJanelaHoras) && account.autoReplyJanelaHoras! >= 1 && account.autoReplyJanelaHoras! <= AUTO_REPLY_JANELA_HORAS_LIMITE
      ? account.autoReplyJanelaHoras!
      : AUTO_REPLY_JANELA_HORAS;
  return { max, janelaHoras, janelaMs: janelaHoras * 3600_000 };
}

/**
 * Texto que será enviado: o da conta, exatamente como foi configurado, ou o padrão do controlador (`controlador`)
 * quando está vazio. O padrão ensina a parar (responda SAIR); o texto próprio é decisão da empresa e não leva
 * instrução acrescentada.
 */
export function autoReplyTextOf(account: AccountLike, controlador?: ControladorAutoReply | null): string {
  const t = account.autoReplyText?.trim();
  if (!t) return autoReplyPadraoDo(controlador);
  // Texto configurado pela empresa sai exatamente como foi escrito (sem acrescentar instrução de saída).
  return t.slice(0, TEXT_MAX_CHARS);
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
    const limites = autoReplyLimitesOf(account);
    const enviadas = await prisma.waMessage.count({
      where: { tenantId, conversationId: inbound.conversationId, direction: "SAIDA", automatic: true, timestamp: { gte: new Date(now.getTime() - limites.janelaMs) } },
    });
    if (enviadas >= limites.max) return false;

    const conversation = await prisma.conversation.findFirst({ where: { id: inbound.conversationId, tenantId }, select: { id: true, waId: true } });
    if (!conversation) return false;
    // LGPD 02-08: o padrão usa os dados do controlador DESTE tenant (nunca os de outro)
    const controlador = await prisma.tenant
      .findUnique({ where: { id: tenantId }, select: { name: true, controladorNome: true, encarregadoNome: true, encarregadoContato: true } })
      .catch(() => null);
    const texto = autoReplyTextOf(account, controlador);
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

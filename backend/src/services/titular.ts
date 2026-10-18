import type { AppPrismaClient } from "../config/db";

/**
 * Direitos do titular (LGPD art. 18 e 19). Duas peças:
 * - relatorioTitular: tudo o que o sistema guarda de UM cliente, em JSON estruturado (acesso, art. 18 II, e
 *   portabilidade/cópia em formato reutilizável, art. 19 §3º), com a lista de com quem o dado foi compartilhado
 *   (art. 18 VII).
 * - regras dos pedidos de titular (PedidoTitular): prazo de 15 dias (art. 19 II) e vencidos.
 */

/** LGPD 03-05: prazo de resposta do art. 19, II, contado da entrada do pedido. */
export const PRAZO_PEDIDO_DIAS = 15;

export const TIPOS_PEDIDO = [
  "CONFIRMACAO",
  "ACESSO",
  "CORRECAO",
  "ELIMINACAO",
  "BLOQUEIO",
  "PORTABILIDADE",
  "COMPARTILHAMENTO",
  "OPOSICAO",
  "REVOGACAO",
] as const;
export const CANAIS_PEDIDO = ["WHATSAPP", "SMS", "EMAIL", "TELEFONE", "OUTRO"] as const;
export const STATUS_PEDIDO = ["ABERTO", "ATENDIDO", "NEGADO"] as const;

export function prazoDoPedido(recebidoEm: Date): Date {
  return new Date(recebidoEm.getTime() + PRAZO_PEDIDO_DIAS * 86_400_000);
}

/** Vencido = ainda aberto e com o prazo já passado. Pedido fechado nunca está vencido. */
export function pedidoVencido(p: { status: string; prazoEm: Date }, agora = new Date()): boolean {
  return p.status === "ABERTO" && p.prazoEm.getTime() < agora.getTime();
}

/**
 * LGPD 03-02 / 03-06 (art. 18 VII): quem recebeu o dado. Os nomes de provedor são os que o envio grava em
 * MessageEvent.provider (services/campaignQueue.ts) e o provider da conta de WhatsApp das conversas.
 */
const SUBOPERADORES: Record<string, { nome: string; finalidade: string }> = {
  whatsapp_cloud_api: { nome: "Meta Platforms (WhatsApp Business Cloud API)", finalidade: "envio e recebimento de mensagens de WhatsApp" },
  META: { nome: "Meta Platforms (WhatsApp Business Cloud API)", finalidade: "envio e recebimento de mensagens de WhatsApp" },
  zapi: { nome: "Z-API", finalidade: "envio e recebimento de mensagens de WhatsApp" },
  ZAPI: { nome: "Z-API", finalidade: "envio e recebimento de mensagens de WhatsApp" },
  twilio: { nome: "Twilio", finalidade: "envio de SMS" },
  zenvia: { nome: "Zenvia", finalidade: "envio de SMS" },
};

/** Provedores que não são terceiros (simulação local) ou não chegaram a enviar. */
const SEM_TERCEIRO = new Set(["mock", "none"]);

/** Hospedagem do próprio sistema: recebe todos os dados guardados, independentemente de mensagem. */
export const INFRAESTRUTURA = [
  { nome: "Vercel", finalidade: "hospedagem da aplicação" },
  { nome: "Supabase", finalidade: "banco de dados" },
];

export function suboperadoresDe(provedores: Array<{ provider: string | null | undefined; channel?: string | null }>) {
  const vistos = new Map<string, { nome: string; finalidade: string; provedor: string; canal: string | null }>();
  for (const p of provedores) {
    // MessageEvent de WhatsApp sem provider gravado (eventos antigos) foi pela API oficial
    const chave = p.provider || (p.channel === "WHATSAPP" ? "whatsapp_cloud_api" : null);
    if (!chave || SEM_TERCEIRO.has(chave)) continue;
    const info = SUBOPERADORES[chave] ?? { nome: chave, finalidade: "envio de mensagens" };
    if (!vistos.has(info.nome)) vistos.set(info.nome, { ...info, provedor: chave, canal: p.channel ?? null });
  }
  return [...vistos.values()];
}

/**
 * LGPD 03-02: relatório completo do titular. Toda consulta filtra por tenantId (direto ou pela relação).
 * Nunca inclui o hash do documento nem o binário de mídia (só os metadados da mensagem).
 * Devolve null se o cliente não existe neste tenant.
 */
export async function relatorioTitular(prisma: AppPrismaClient, tenantId: string, clientId: string) {
  const client = await prisma.client.findFirst({ where: { id: clientId, tenantId } });
  if (!client) return null;
  // hash do documento e chaves internas não são dado do titular legível; ficam de fora
  const { cpfHash, tenantId: _t, ...titular } = client;

  const [tenant, importJob, movimentacoes, historicoConta, compras, conversas, listasManuais, pedidos, auditoria] = await Promise.all([
    prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, controladorNome: true, encarregadoNome: true, encarregadoContato: true, avisoPrivacidadeUrl: true, baseLegalMarketing: true },
    }),
    client.lastImportJobId
      ? prisma.importJob.findFirst({
          where: { id: client.lastImportJobId, tenantId },
          select: { source: true, formato: true, nomeArquivo: true, startedAt: true },
        })
      : Promise.resolve(null),
    prisma.movement.findMany({
      where: { clientId, client: { tenantId } },
      orderBy: { data: "asc" },
      select: { id: true, tipo: true, valor: true, data: true, createdAt: true },
    }),
    prisma.accountSnapshot.findMany({
      where: { tenantId, clientId },
      orderBy: { recordedAt: "asc" },
      select: { recordedAt: true, limiteTotal: true, saldoDisponivel: true, saldoAnterior: true, valorUtilizado: true, statusConta: true },
    }),
    prisma.purchase.findMany({
      where: { tenantId, clientId },
      orderBy: { occurredAt: "asc" },
      select: { occurredAt: true, tipo: true, merchantName: true, razaoSocial: true, valorPrincipal: true, valorParcela: true, juros: true },
    }),
    prisma.conversation.findMany({
      where: { tenantId, clientId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        waId: true,
        contactName: true,
        status: true,
        createdAt: true,
        lastMessageAt: true,
        account: { select: { provider: true, displayPhone: true } },
      },
    }),
    prisma.campaignRecipient.findMany({
      where: { tenantId, OR: [{ clientId }, { cpfHash }, { telefone: client.telefone }] },
      orderBy: { createdAt: "asc" },
      select: { id: true, nome: true, telefone: true, cpfMasked: true, limiteDisponivel: true, optOutAt: true, createdAt: true, campaign: { select: { id: true, name: true } } },
    }),
    prisma.pedidoTitular.findMany({
      where: { tenantId, clientId },
      orderBy: { recebidoEm: "asc" },
      select: { id: true, tipo: true, canal: true, status: true, descricao: true, recebidoEm: true, prazoEm: true, respondidoEm: true, resposta: true },
    }),
    prisma.auditLog.findMany({
      where: { tenantId, targetId: clientId },
      orderBy: { createdAt: "asc" },
      // sem userId: a identidade do funcionário não é dado do titular
      select: { action: true, target: true, details: true, createdAt: true },
    }),
  ]);

  // inclui os envios de lista manual feitos antes de o contato ser ligado ao cliente (recipientId)
  const recipientIds = listasManuais.map((r) => r.id);
  const mensagens = await prisma.messageEvent.findMany({
    where: { campaign: { tenantId }, OR: [{ clientId }, ...(recipientIds.length ? [{ recipientId: { in: recipientIds } }] : [])] },
    orderBy: { queuedAt: "asc" },
    select: {
      id: true,
      channel: true,
      provider: true,
      status: true,
      variant: true,
      queuedAt: true,
      sentAt: true,
      deliveredAt: true,
      respondedAt: true,
      clickedAt: true,
      convertedAt: true,
      error: true,
      campaign: { select: { id: true, name: true } },
    },
  });

  const conversaIds = conversas.map((c) => c.id);
  const waMensagens = conversaIds.length
    ? await prisma.waMessage.findMany({
        where: { tenantId, conversationId: { in: conversaIds } },
        orderBy: { timestamp: "asc" },
        // só metadados da mídia; o arquivo (WaMediaBlob) nunca entra
        select: { conversationId: true, direction: true, type: true, body: true, mediaMime: true, mediaFilename: true, status: true, automatic: true, timestamp: true },
      })
    : [];

  const suboperadores = suboperadoresDe([
    ...mensagens.map((m) => ({ provider: m.provider, channel: m.channel })),
    ...conversas.map((c) => ({ provider: c.account.provider, channel: "WHATSAPP" })),
  ]);

  return {
    geradoEm: new Date().toISOString(),
    controlador: {
      nome: tenant?.controladorNome || tenant?.name || null,
      encarregado: tenant?.encarregadoNome ?? null,
      contatoEncarregado: tenant?.encarregadoContato ?? null,
      avisoPrivacidade: tenant?.avisoPrivacidadeUrl ?? null,
      baseLegalMarketing: tenant?.baseLegalMarketing ?? null,
    },
    titular,
    origem: {
      origemCliente: client.origemCliente,
      ultimaImportacao: importJob,
    },
    movimentacoes,
    historicoConta,
    compras,
    mensagens,
    conversas: conversas.map((c) => ({
      id: c.id,
      telefone: c.waId,
      nomePerfil: c.contactName,
      status: c.status,
      canal: c.account.provider,
      numeroDaEmpresa: c.account.displayPhone,
      inicio: c.createdAt,
      ultimaMensagem: c.lastMessageAt,
      mensagens: waMensagens.filter((m) => m.conversationId === c.id).map(({ conversationId: _c, ...m }) => m),
    })),
    listasManuais: listasManuais.map(({ id: _id, ...r }) => r),
    pedidos,
    registrosAuditoria: auditoria,
    compartilhamento: { suboperadores, infraestrutura: INFRAESTRUTURA },
  };
}

export type RelatorioTitular = NonNullable<Awaited<ReturnType<typeof relatorioTitular>>>;

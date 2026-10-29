import { Prisma } from "../generated/prisma/client";
import { AppPrismaClient, tenantRaw } from "../config/db";
import { logAudit } from "../middleware/audit";
import { runWithTenantContextAsync, withCrossTenantAccess } from "../config/tenantGuard";
import { ACAO_REDACAO_AUDITORIA, registroRedacao, RegistroRedacao } from "./auditIntegrity";
import { suprimir, variantesTelefone } from "./privacy";
import { IMPORT_CHANGE_TTL_DIAS } from "./importUndo";
import { deleteMessageMedia } from "./mediaStore";

/**
 * Retenção, anonimização e eliminação (LGPD art. 15, 16 e 18, VI).
 *
 * `anonymizeClient` é a única rotina que anonimiza um titular: usada pelo pedido de eliminação
 * (POST /api/clients/:id/anonymize) e pelo job diário (`runRetentionSweep`). Ela:
 *  1. grava a supressão por ELIMINACAO (hash do telefone e do documento REAIS, antes de sobrescrevê-los),
 *     para a reimportação não recriar o titular (LGPD 03-01);
 *  2. anonimiza os dados ligados (Inbox, listas manuais, mensagens, compras) e apaga o histórico
 *     por pessoa (snapshots, movimentações, estado de desfazer, notificações) (LGPD 04-01);
 *  3. anonimiza o próprio Client campo a campo (ver `dadosAnonimizados`);
 *  4. tira a PII de AuditLog antigos SEM quebrar a cadeia de hash (evento encadeado, ver auditIntegrity.ts);
 *  5. registra a ação no AuditLog, sem PII, avisando das cópias fora do CRM (Z-API, LGPD 04-08).
 * Idempotente: rodar de novo num cliente já anonimizado só limpa o que tiver sobrado.
 */

export const ANON_NOME = "Cliente anonimizado";
export const ANON_DOC = "***.***.***-**";
export const ANON_CONTATO = "Contato anonimizado";
const ANON_PREFIX = "anon-";

/** Quantos clientes cada categoria do job anonimiza por tenant e por execução (função serverless tem tempo limitado). */
export const RETENCAO_LOTE = 200;

/**
 * Chaves de AuditLog.details que carregam dado pessoal de cliente (campos do Client e da Inbox). Redigidas
 * nas linhas que apontam para o cliente anonimizado (target="Client", targetId=id).
 */
const PII_DETAIL_KEYS = [
  "nome", "telefone", "cpf", "documento", "cpfHash", "cpfMasked", "cidade", "tags", "email", "externalId",
  "dataNascimento", "sexo", "remuneracaoBruta", "remuneracaoLiquida", "bonus", "saldoLiquidoSaque",
  "empresaConveniada", "cidadeEmpresaConveniada", "vinculoEmpregaticio", "lotacao", "razaoSocial",
  "motivoEncerramento", "obsEncerramento", "statusValidacaoCadastro", "waId", "contactName", "body",
] as const;
export const REDACTED_MARKER = "[redacted-anonimizacao]";

/** Aviso de LGPD 04-08: a Z-API (QR code) guarda cópia das conversas no aparelho pareado e no provedor. */
export const AVISO_COPIA_ZAPI =
  "Há conversas deste titular pela Z-API: o histórico (texto e mídia) continua no celular pareado e na Z-API. " +
  "Apague manualmente no aparelho (conversa do número) — o CRM não tem como apagar essas cópias.";

/**
 * Redige, em um objeto `details` de AuditLog (JSON solto, sem schema), qualquer chave de topo cujo nome
 * bata com um campo PII. Varredura rasa (os call sites de logAudit gravam objetos planos).
 */
export function redactPiiFromDetails(details: unknown): { value: unknown; changed: boolean } {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return { value: details, changed: false };
  }
  const source = details as Record<string, unknown>;
  let changed = false;
  const result: Record<string, unknown> = { ...source };
  for (const key of PII_DETAIL_KEYS) {
    if (key in source && source[key] !== REDACTED_MARKER) {
      result[key] = REDACTED_MARKER;
      changed = true;
    }
  }
  return { value: result, changed };
}

/**
 * LGPD 04-01: redige PII residual em AuditLog que apontam para estes clientes (target="Client", targetId).
 * Não apaga a linha ("a ação X aconteceu em T" continua sendo trilha legítima). Para não quebrar a cadeia
 * de hash (pendência do Lote 5), grava ANTES um evento encadeado AUDIT_REDACAO_LGPD que sela, de cada linha,
 * o hash original, os metadados e o hash do details NOVO (nunca o conteúdo antigo); verifyAuditChain aceita
 * a linha reescrita só com esse evento. Gravar o evento antes é seguro: se a reescrita falhar, a linha
 * continua com o conteúdo original, que ainda confere com o hash dela.
 */
export async function redigirAuditoria(prisma: AppPrismaClient, tenantId: string, clientIds: string[], motivo: string): Promise<number> {
  if (clientIds.length === 0) return 0;
  const logs = await prisma.auditLog.findMany({
    where: { tenantId, target: "Client", targetId: { in: clientIds } },
    select: { id: true, tenantId: true, userId: true, action: true, target: true, targetId: true, details: true, createdAt: true, prevHash: true, hash: true },
  });
  const mudancas = logs
    .map((log) => ({ log, ...redactPiiFromDetails(log.details) }))
    .filter((m) => m.changed);
  if (mudancas.length === 0) return 0;

  // linhas fora da cadeia (gravadas antes do hash, `hash` nulo) não precisam de registro
  const registros: RegistroRedacao[] = mudancas
    .filter((m) => m.log.hash)
    .map((m) => registroRedacao({ ...m.log, hash: m.log.hash! }, m.value));
  for (let i = 0; i < registros.length; i += 200) {
    await logAudit({ tenantId, action: ACAO_REDACAO_AUDITORIA, target: "AuditLog", details: { motivo, linhas: registros.slice(i, i + 200) } });
  }
  for (const m of mudancas) {
    // update por id: o id veio do findMany acima, já escopado por tenantId (verify-then-act)
    await prisma.auditLog.update({ where: { id: m.log.id }, data: { details: m.value as Prisma.InputJsonValue } });
  }
  return mudancas.length;
}

/** Primeiro dia do mês (UTC): a data fina vira mês, o que mantém estatística mensal sem identificar. */
export function inicioDoMes(d: Date | null | undefined): Date | null {
  if (!d) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

type ClienteParaAnonimizar = {
  id: string;
  optOutAt: Date | null;
  anonymizedAt: Date | null;
  createdAt: Date;
  dataCadastro: Date | null;
  dataAberturaConta: Date | null;
  dataValidadeCartao: Date | null;
  dataUltimaUtilizacao: Date | null;
  ultimoUsoReal: Date | null;
  encerradoEm: Date | null;
};

/**
 * LGPD 04-01: o que fica de um Client anonimizado, campo a campo.
 *  - Identificadores diretos → pseudônimo fixo/nulo: nome, telefone, cpfHash/cpfMasked, documentoTipo,
 *    externalId (id do cartão na planilha da controladora: reidentificaria pelos meios dela, art. 12), e-mail.
 *  - Quase-identificadores → nulo: cidade (e o dia do ciclo, que revela a cidade), nascimento, sexo, renda,
 *    bônus, saldo para saque, convênio e sua cidade, vínculo, lotação, razão social, status de validação,
 *    motivo/observação do encerramento, tags, correções manuais e o lote de importação.
 *  - Datas finas → mês: cadastro, abertura, validade, último uso (planilha e extrato), encerramento, criação.
 *  - Ficam (agregado sem identificação, usado pelos KPIs): limite, utilizado, saldo, antecipado, percentual,
 *    faixa, contagens de uso, status da conta, origem, bloqueio a pedido.
 *  - Comunicação: sem autorização e com opt-out (preserva a data do primeiro pedido).
 */
export function dadosAnonimizados(c: ClienteParaAnonimizar, agora: Date): Prisma.ClientUpdateInput {
  return {
    nome: ANON_NOME,
    telefone: `${ANON_PREFIX}${c.id}`,
    cpfHash: `${ANON_PREFIX}${c.id}`,
    cpfMasked: ANON_DOC,
    documentoTipo: null,
    externalId: null,
    email: null,
    cidade: null,
    diaCicloAbertura: null,
    dataNascimento: null,
    sexo: null,
    remuneracaoBruta: null,
    remuneracaoLiquida: null,
    bonus: null,
    saldoLiquidoSaque: null,
    empresaConveniada: null,
    cidadeEmpresaConveniada: null,
    vinculoEmpregaticio: null,
    lotacao: null,
    razaoSocial: null,
    statusValidacaoCadastro: null,
    motivoEncerramento: null,
    obsEncerramento: null,
    tags: { deleteMany: {} },
    camposCorrigidos: Prisma.DbNull,
    lastImportJobId: null,
    dataCadastro: inicioDoMes(c.dataCadastro),
    dataAberturaConta: inicioDoMes(c.dataAberturaConta),
    dataValidadeCartao: inicioDoMes(c.dataValidadeCartao),
    dataUltimaUtilizacao: inicioDoMes(c.dataUltimaUtilizacao),
    ultimoUsoReal: inicioDoMes(c.ultimoUsoReal),
    encerradoEm: inicioDoMes(c.encerradoEm),
    createdAt: inicioDoMes(c.createdAt) ?? c.createdAt,
    autorizacaoComunicacao: false,
    optOutAt: c.optOutAt ?? agora,
    anonymizedAt: c.anonymizedAt ?? agora,
  };
}

export type OrigemAnonimizacao = "RETENCAO" | "RETENCAO_ENCERRAMENTO" | "RETENCAO_RESIDUO" | "PEDIDO_TITULAR";

export interface AnonymizeOptions {
  /** por que (texto do operador, ou o prazo de retenção no job) */
  motivo: string;
  origem: OrigemAnonimizacao;
  pedidoId?: string | null;
  userId?: string | null;
  agora?: Date;
}

export interface AnonymizeResult {
  clientId: string;
  jaAnonimizado: boolean;
  supressaoGravada: boolean;
  removidos: { importChanges: number; historicoConta: number; movimentacoes: number; notificacoes: number; midias: number };
  anonimizados: { compras: number; mensagensCampanha: number; destinatarios: number; conversas: number; mensagensInbox: number };
  auditoriaRedigida: number;
  /** LGPD 04-08: cópias fora do CRM que precisam ser apagadas à mão */
  copiasExternas: { provedor: "ZAPI"; conversas: number; aviso: string }[];
}

/**
 * LGPD 03-01 / 03-09: limpa o que se liga a um contato pelo número (e, quando há, pelo cliente e pelo documento):
 * conversas da Inbox (número pseudonimizado, texto, arquivo e mídia fora), destinatários de lista manual e o id na
 * operadora/erro das mensagens de campanha. Usado pela eliminação de cliente e pela de contato fora da base.
 */
async function limparContato(
  prisma: AppPrismaClient,
  tenantId: string,
  alvo: { clientId?: string | null; variantes: string[]; docHash?: string | null }
) {
  const { clientId, variantes, docHash } = alvo;
  const waIds = variantes.map((v) => v.replace("+", ""));

  // 2a) Inbox (LGPD 04-02): conversas do cliente ou do número dele, inclusive as sem vínculo
  const conversas = await prisma.conversation.findMany({
    where: {
      tenantId,
      OR: [...(clientId ? [{ clientId }] : []), ...(waIds.length ? [{ waId: { in: waIds }, ...(clientId ? {} : { clientId: null }) }] : [])],
    },
    select: { id: true, waId: true, account: { select: { provider: true } } },
  });
  const convIds = conversas.map((c) => c.id);
  let midias = 0;
  let mensagensInbox = 0;
  if (convIds.length) {
    const msgs = await prisma.waMessage.findMany({ where: { tenantId, conversationId: { in: convIds } }, select: { id: true } });
    if (msgs.length) {
      midias = await deleteMessageMedia(prisma, { tenantId, messageId: { in: msgs.map((m) => m.id) } });
      mensagensInbox = (
        await prisma.waMessage.updateMany({
          where: { tenantId, conversationId: { in: convIds } },
          data: { body: null, mediaFilename: null, mediaId: null, errorText: null, wamid: null },
        })
      ).count;
    }
    for (const c of conversas) {
      if (c.waId.startsWith(ANON_PREFIX)) continue;
      await prisma.conversation.update({ where: { id: c.id }, data: { waId: `${ANON_PREFIX}${c.id}`, contactName: null, lastPreview: null } });
    }
  }
  const conversasZapi = conversas.filter((c) => c.account?.provider === "ZAPI").length;

  // 2b) listas manuais: o destinatário ligado ao cliente, ao número ou ao documento. Pelo número só quando o
  //     destinatário não tem documento ou tem o mesmo: com outro CPF é outra pessoa (número reaproveitado)
  const porNumero = variantes.length
    ? [{ telefone: { in: variantes }, OR: [{ cpfHash: null }, ...(docHash ? [{ cpfHash: docHash }] : [])], ...(clientId ? {} : { clientId: null }) }]
    : [];
  const destinatarios = await prisma.campaignRecipient.findMany({
    where: { tenantId, OR: [...(clientId ? [{ clientId }] : []), ...porNumero, ...(docHash ? [{ cpfHash: docHash }] : [])] },
    select: { id: true, telefone: true },
  });
  for (const r of destinatarios) {
    if (r.telefone.startsWith(ANON_PREFIX)) continue;
    await prisma.campaignRecipient.update({
      where: { id: r.id },
      data: { nome: ANON_CONTATO, telefone: `${ANON_PREFIX}${r.id}`, cpfHash: null, cpfMasked: null, limiteDisponivel: null },
    });
  }

  // 2c) mensagens de campanha: o resultado fica; o id na operadora e o erro (pode citar o número) saem
  const filtrosEvento = [...(clientId ? [{ clientId }] : []), ...(destinatarios.length ? [{ recipientId: { in: destinatarios.map((r) => r.id) } }] : [])];
  const mensagensCampanha = filtrosEvento.length
    ? (await prisma.messageEvent.updateMany({ where: { campaign: { tenantId }, OR: filtrosEvento }, data: { providerMsgId: null, error: null } })).count
    : 0;

  return { convIds, conversasZapi, midias, mensagensInbox, destinatarios, mensagensCampanha };
}

/** Meia-noite de Brasília (UTC-3, sem horário de verão) do dia de `d`. */
export function inicioDoDiaBrasilia(d: Date): Date {
  const brt = new Date(d.getTime() - 3 * 3_600_000);
  return new Date(Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), brt.getUTCDate(), 3));
}

/** Anonimiza um titular e tudo o que se liga a ele. Devolve null se o cliente não existe neste tenant. */
export async function anonymizeClient(
  prisma: AppPrismaClient,
  tenantId: string,
  clientId: string,
  opts: AnonymizeOptions
): Promise<AnonymizeResult | null> {
  const agora = opts.agora ?? new Date();
  const client = await prisma.client.findFirst({ where: { id: clientId, tenantId } });
  if (!client) return null;

  // Já anonimizado (pela versão antiga da retenção): telefone e documento já são pseudônimos.
  const dadosReais = !client.cpfHash.startsWith(ANON_PREFIX);
  const variantes = dadosReais ? variantesTelefone(client.telefone) : [];

  // 1) LGPD 03-01: supressão ANTES de sobrescrever os hashes reais. Sem o id do pedido e com a data reduzida ao
  //    dia (art. 12): a controladora tem o CPF, e um elo com o pedido ou um horário que casa com a trilha levaria
  //    do hash ao cliente anonimizado. A importação só compara a data com a abertura da conta, e o dia basta.
  let supressaoGravada = false;
  if (dadosReais) {
    const sup = await suprimir(prisma, tenantId, {
      telefone: client.telefone,
      docHash: client.cpfHash,
      motivo: "ELIMINACAO",
      origem: `anonimizacao:${opts.origem}`,
      createdAt: inicioDoDiaBrasilia(agora),
    });
    supressaoGravada = !!sup;
  }

  // 2a–2c) Inbox, listas manuais e mensagens de campanha do cliente, do número e do documento
  const { convIds, conversasZapi, midias, mensagensInbox, destinatarios, mensagensCampanha } = await limparContato(prisma, tenantId, {
    clientId,
    variantes,
    docHash: dadosReais ? client.cpfHash : null,
  });

  // 2d) compras: ficam para estatística (valor, lojista, tipo, mês), sem o id da transação (a controladora
  // reidentificaria pela própria planilha), sem a razão social e com a data reduzida ao mês. Um id por linha:
  // SQL cru pelo tenantRaw (RLS com o tenant).
  const compras = await tenantRaw.execute(
    `UPDATE "Purchase" SET "externalId" = 'anon-' || "id", "razaoSocial" = NULL, "occurredAt" = strftime('%Y-%m-01T00:00:00.000+00:00', "occurredAt")
     WHERE "tenantId" = $1 AND "clientId" = $2 AND "externalId" NOT LIKE 'anon-%'`,
    tenantId,
    clientId
  );

  // 2e) histórico por pessoa, sem uso agregado (o agregado diário fica em DashboardSnapshot): apaga
  const historicoConta = (await prisma.accountSnapshot.deleteMany({ where: { tenantId, clientId } })).count;
  const movimentacoes = (await prisma.movement.deleteMany({ where: { clientId, client: { tenantId } } })).count;
  // LGPD 04-04: o estado anterior guardado para desfazer importação reidentificaria o cliente
  const importChanges = (await prisma.importChange.deleteMany({ where: { tenantId, clientId } })).count;
  const notificacoes = (await prisma.notification.deleteMany({ where: { tenantId, relatedType: "Client", relatedId: clientId } })).count;
  // 2f) pedidos do titular: tipo, canal, datas e status ficam (prova do atendimento e do prazo); o texto livre, que
  //     pode citar o titular, e o vínculo com o cliente saem (LGPD 03-01 / art. 16). Pedido de eliminação aberto
  //     deste cliente fica atendido: sem o vínculo, ninguém mais saberia a quem ele se refere.
  const eliminacoesAbertas = (
    await prisma.pedidoTitular.findMany({ where: { tenantId, clientId, tipo: "ELIMINACAO", status: "ABERTO" }, select: { id: true } })
  ).map((p) => p.id);
  await prisma.pedidoTitular.updateMany({
    where: { tenantId, clientId },
    data: { clientId: null, descricao: null, resposta: null, telefoneMasked: null },
  });
  if (eliminacoesAbertas.length) {
    await prisma.pedidoTitular.updateMany({
      where: { tenantId, id: { in: eliminacoesAbertas } },
      data: { status: "ATENDIDO", respondidoEm: agora, resposta: "Dados eliminados (anonimização) no CRM." },
    });
  }

  // 3) o próprio cliente (LGPD 04-01)
  await prisma.client.update({ where: { id: client.id }, data: dadosAnonimizados(client, agora) });

  // 4) AuditLog antigo, sem quebrar a cadeia
  const auditoriaRedigida = await redigirAuditoria(prisma, tenantId, [client.id], `ANONIMIZACAO:${opts.origem}`);

  const copiasExternas = conversasZapi ? [{ provedor: "ZAPI" as const, conversas: conversasZapi, aviso: AVISO_COPIA_ZAPI }] : [];
  const result: AnonymizeResult = {
    clientId: client.id,
    jaAnonimizado: !!client.anonymizedAt,
    supressaoGravada,
    removidos: { importChanges, historicoConta, movimentacoes, notificacoes, midias },
    anonimizados: { compras, mensagensCampanha, destinatarios: destinatarios.length, conversas: convIds.length, mensagensInbox },
    auditoriaRedigida,
    copiasExternas,
  };

  // 5) trilha, sem PII
  await logAudit({
    tenantId,
    userId: opts.userId ?? undefined,
    action: opts.origem === "PEDIDO_TITULAR" ? "ELIMINACAO_TITULAR" : "RETENTION_ANONYMIZE",
    target: "Client",
    targetId: client.id,
    details: {
      origem: opts.origem,
      motivo: opts.motivo.slice(0, 500),
      pedidoId: opts.pedidoId ?? null,
      supressaoGravada,
      removidos: result.removidos,
      anonimizados: result.anonimizados,
      auditoriaRedigida,
      // LGPD 04-08: o que o CRM não alcança fica registrado como pendência manual
      copiasExternas: copiasExternas.map((c) => ({ provedor: c.provedor, conversas: c.conversas, apagarManualmente: true })),
    },
  });
  return result;
}

export type AnonymizeContatoResult =
  | { clienteDaBase: string }
  | {
      supressaoGravada: boolean;
      removidos: { midias: number };
      anonimizados: { conversas: number; mensagensInbox: number; destinatarios: number; mensagensCampanha: number };
      copiasExternas: { provedor: "ZAPI"; conversas: number; aviso: string }[];
    };

/**
 * LGPD 03-09: eliminação de quem NÃO é cliente da base (contato de lista manual, quem só escreveu no WhatsApp),
 * pelo telefone. Grava a supressão ELIMINACAO só pelo número (o envio já sabe tratar eliminação sem documento) e
 * limpa conversas sem cliente, destinatários sem cliente e os ids de envio. Se o número é de um cliente da base,
 * não faz nada e devolve o id: a eliminação dele é a da ficha (anonymizeClient), que alcança compras e histórico.
 * Devolve null para telefone inválido. Audita sem PII.
 */
export async function anonymizeContato(
  prisma: AppPrismaClient,
  tenantId: string,
  telefone: string,
  opts: { motivo: string; pedidoId?: string | null; userId?: string | null; agora?: Date }
): Promise<AnonymizeContatoResult | null> {
  const variantes = variantesTelefone(telefone);
  if (variantes.length === 0) return null;
  const cliente = await prisma.client.findFirst({ where: { tenantId, telefone: { in: variantes }, anonymizedAt: null }, select: { id: true } });
  if (cliente) return { clienteDaBase: cliente.id };

  const sup = await suprimir(prisma, tenantId, {
    telefone,
    motivo: "ELIMINACAO",
    origem: "anonimizacao:CONTATO",
    createdAt: inicioDoDiaBrasilia(opts.agora ?? new Date()),
  });
  const r = await limparContato(prisma, tenantId, { variantes });
  const copiasExternas = r.conversasZapi ? [{ provedor: "ZAPI" as const, conversas: r.conversasZapi, aviso: AVISO_COPIA_ZAPI }] : [];
  const result = {
    supressaoGravada: !!sup,
    removidos: { midias: r.midias },
    anonimizados: { conversas: r.convIds.length, mensagensInbox: r.mensagensInbox, destinatarios: r.destinatarios.length, mensagensCampanha: r.mensagensCampanha },
    copiasExternas,
  };
  await logAudit({
    tenantId,
    userId: opts.userId ?? undefined,
    action: "ELIMINACAO_CONTATO",
    target: "PedidoTitular",
    targetId: opts.pedidoId ?? undefined,
    details: {
      motivo: opts.motivo.slice(0, 500),
      ...result,
      copiasExternas: copiasExternas.map((c) => ({ provedor: c.provedor, conversas: c.conversas, apagarManualmente: true })),
    },
  });
  return result;
}

/* ───────────────────────── job diário ───────────────────────── */

const DIA = 86_400_000;
const diasAtras = (agora: Date, dias: number) => new Date(agora.getTime() - dias * DIA);

/** LGPD 04-04 / 01-02: o estado anterior para desfazer importação só vale 30 dias; depois é apagado. */
export async function expirarImportChanges(prisma: AppPrismaClient, tenantId: string, agora = new Date()): Promise<number> {
  return (await prisma.importChange.deleteMany({ where: { tenantId, createdAt: { lt: diasAtras(agora, IMPORT_CHANGE_TTL_DIAS) } } })).count;
}

/**
 * LGPD 04-02: prazo da Inbox. Mensagens mais antigas que `inboxRetentionDays` (nulo = `retentionDays`)
 * perdem o conteúdo (texto, nome do arquivo, id da mídia) e a cópia da mídia; conversa parada há mais
 * que o prazo perde o número (pseudônimo) e o nome do perfil, com ou sem cliente ligado (Meta e Z-API).
 * Cópias de mídia têm prazo próprio, mais curto (`mediaRetentionDays`, padrão 90).
 */
export async function retencaoInbox(
  prisma: AppPrismaClient,
  tenant: { id: string; retentionDays: number; inboxRetentionDays: number | null; mediaRetentionDays: number },
  agora = new Date()
) {
  const tenantId = tenant.id;
  const corte = diasAtras(agora, tenant.inboxRetentionDays ?? tenant.retentionDays);

  const antigas = await prisma.waMessage.findMany({
    where: { tenantId, timestamp: { lte: corte }, OR: [{ body: { not: null } }, { mediaFilename: { not: null } }, { mediaId: { not: null } }, { errorText: { not: null } }] },
    select: { id: true },
    take: 5000,
  });
  let mensagens = 0;
  let midias = 0;
  if (antigas.length) {
    const ids = antigas.map((m) => m.id);
    midias += await deleteMessageMedia(prisma, { tenantId, messageId: { in: ids } });
    mensagens = (await prisma.waMessage.updateMany({ where: { tenantId, id: { in: ids } }, data: { body: null, mediaFilename: null, mediaId: null, errorText: null } })).count;
  }

  const paradas = await prisma.conversation.findMany({
    where: { tenantId, lastMessageAt: { lte: corte }, NOT: { waId: { startsWith: ANON_PREFIX } } },
    select: { id: true },
    take: 500,
  });
  for (const c of paradas) {
    await prisma.conversation.update({ where: { id: c.id }, data: { waId: `${ANON_PREFIX}${c.id}`, contactName: null, lastPreview: null } });
  }

  midias += await deleteMessageMedia(prisma, { tenantId, createdAt: { lte: diasAtras(agora, tenant.mediaRetentionDays) } });
  return { mensagens, conversas: paradas.length, midias };
}

/** Já anonimizado pela versão antiga (só nome/telefone/CPF/cidade/tags), mas com sobra de dado pessoal. */
const RESIDUO_WHERE: Prisma.ClientWhereInput = {
  OR: [
    { externalId: { not: null } }, { email: { not: null } }, { dataNascimento: { not: null } }, { sexo: { not: null } },
    { remuneracaoBruta: { not: null } }, { remuneracaoLiquida: { not: null } }, { bonus: { not: null } }, { saldoLiquidoSaque: { not: null } },
    { empresaConveniada: { not: null } }, { cidadeEmpresaConveniada: { not: null } }, { vinculoEmpregaticio: { not: null } },
    { lotacao: { not: null } }, { razaoSocial: { not: null } }, { motivoEncerramento: { not: null } }, { obsEncerramento: { not: null } },
    { statusValidacaoCadastro: { not: null } }, { diaCicloAbertura: { not: null } },
  ],
};

/**
 * Job diário (03:00 local; /api/cron/retention na Vercel). Por tenant:
 *  - inativos há mais de `retentionDays`: sem uso pela planilha NEM pelo extrato e sem mensagem recebida no
 *    período (LGPD 03-01: a data de ativação da planilha sozinha anonimizava quem usa o cartão);
 *  - contas encerradas há mais de `retentionDaysAfterClosure` (nulo = `retentionDays`), contado de
 *    `encerradoEm` (LGPD 04-06);
 *  - clientes anonimizados pela versão antiga com sobra de dado pessoal (LGPD 04-01);
 *  - contatos de lista manual fora da base, Inbox e mídia (LGPD 04-02) e estado de desfazer (LGPD 04-04).
 */
/**
 * Cliente vencido por inatividade: sem uso (planilha e extrato) nem mensagem recebida desde `cutoff`. Usado pelo
 * job e pela prévia de Configurações → LGPD (routes/tenant.ts), para a prévia contar exatamente o que o job apagaria.
 */
export function inativosWhere(tenantId: string, cutoff: Date): Prisma.ClientWhereInput {
  return {
    tenantId,
    anonymizedAt: null,
    AND: [
      { OR: [{ dataUltimaUtilizacao: { lte: cutoff } }, { AND: [{ dataUltimaUtilizacao: null }, { createdAt: { lte: cutoff } }] }] },
      { OR: [{ ultimoUsoReal: null }, { ultimoUsoReal: { lte: cutoff } }] },
      { conversations: { none: { lastInboundAt: { gt: cutoff } } } },
    ],
  };
}

export async function runRetentionSweep(prisma: AppPrismaClient, agora = new Date()) {
  // Genuinely cross-tenant by design: varre todos os tenants pra achar quem tem sweep de
  // retenção a fazer. Cada tenant é re-escopado abaixo via runWithTenantContextAsync.
  const tenants = await withCrossTenantAccess(() => prisma.tenant.findMany());
  const total = {
    totalAnonymized: 0,
    anonimizadosEncerramento: 0,
    residuosLimpos: 0,
    auditLogsRedacted: 0,
    destinatariosAnonimizados: 0,
    importChangesExpirados: 0,
    inbox: { mensagens: 0, conversas: 0, midias: 0 },
    copiasExternasZapi: 0,
  };

  for (const tenant of tenants) {
    const cutoff = diasAtras(agora, tenant.retentionDays);
    const cutoffEncerramento = diasAtras(agora, tenant.retentionDaysAfterClosure ?? tenant.retentionDays);

    await runWithTenantContextAsync(tenant.id, async () => {
      const anonimizar = async (ids: string[], origem: OrigemAnonimizacao, motivo: string) => {
        let n = 0;
        for (const id of ids) {
          const r = await anonymizeClient(prisma, tenant.id, id, { motivo, origem, agora });
          if (!r) continue;
          n++;
          total.auditLogsRedacted += r.auditoriaRedigida;
          total.copiasExternasZapi += r.copiasExternas.reduce((a, c) => a + c.conversas, 0);
        }
        return n;
      };

      const inativos = await prisma.client.findMany({
        where: inativosWhere(tenant.id, cutoff),
        select: { id: true },
        take: RETENCAO_LOTE,
      });
      total.totalAnonymized += await anonimizar(inativos.map((c) => c.id), "RETENCAO", `inativo há mais de ${tenant.retentionDays} dias`);

      const encerrados = await prisma.client.findMany({
        where: { tenantId: tenant.id, anonymizedAt: null, encerradoEm: { lte: cutoffEncerramento } },
        select: { id: true },
        take: RETENCAO_LOTE,
      });
      const nEnc = await anonimizar(
        encerrados.map((c) => c.id),
        "RETENCAO_ENCERRAMENTO",
        `conta encerrada há mais de ${tenant.retentionDaysAfterClosure ?? tenant.retentionDays} dias`
      );
      total.anonimizadosEncerramento += nEnc;
      total.totalAnonymized += nEnc;

      const residuos = await prisma.client.findMany({
        where: { tenantId: tenant.id, anonymizedAt: { not: null }, ...RESIDUO_WHERE },
        select: { id: true },
        take: RETENCAO_LOTE,
      });
      total.residuosLimpos += await anonimizar(residuos.map((c) => c.id), "RETENCAO_RESIDUO", "limpeza de dado pessoal que sobrou da anonimização antiga");

      // Lista de campanha manual: contatos que nunca entraram na base, depois do mesmo prazo (o envio e o
      // resultado agregado ficam). Os ligados a cliente anonimizado já foram tratados em anonymizeClient.
      const recipients = await prisma.campaignRecipient.findMany({
        where: {
          tenantId: tenant.id,
          nome: { not: ANON_CONTATO },
          OR: [{ client: { anonymizedAt: { not: null } } }, { clientId: null, createdAt: { lte: cutoff } }],
        },
        select: { id: true },
      });
      for (const r of recipients) {
        await prisma.campaignRecipient.update({
          where: { id: r.id },
          data: { nome: ANON_CONTATO, telefone: `${ANON_PREFIX}${r.id}`, cpfHash: null, cpfMasked: null, limiteDisponivel: null },
        });
      }
      total.destinatariosAnonimizados += recipients.length;

      const inbox = await retencaoInbox(prisma, tenant, agora);
      total.inbox.mensagens += inbox.mensagens;
      total.inbox.conversas += inbox.conversas;
      total.inbox.midias += inbox.midias;

      total.importChangesExpirados += await expirarImportChanges(prisma, tenant.id, agora);
    });
  }

  return total;
}

import crypto from "crypto";
import { AppPrismaClient } from "../config/db";
import { digitsOnly, maskPhone, normalizePhone } from "./masking";
import { phoneCandidates } from "./whatsappPayload";

/**
 * LGPD 02-03 / 02-06: supressão por titular. O pedido para parar (opt-out), a eliminação e o bloqueio valem
 * para o TELEFONE (e o documento), não para um registro: sobrevivem a telefone repetido em dois clientes, a
 * contato de lista manual que não é cliente, à anonimização e à reimportação. A tabela `SupressaoTitular` guarda
 * só hashes (HMAC-SHA256 com `Tenant.cpfSalt`, o mesmo salt do CPF), nunca o dado em claro.
 *
 * Escopo: todos os canais (padrão da triagem); `canal` fica gravado só como origem do pedido.
 */

export type MotivoSupressao = "OPT_OUT" | "ELIMINACAO" | "BLOQUEIO";

/**
 * Telefone brasileiro canônico (E.164, celular SEMPRE com o nono dígito). Estável para as duas formas que
 * circulam no sistema: a da base (+5584999998888) e a que a Meta às vezes informa (558499998888). Número
 * sem DDI (DDD + número) é tratado como brasileiro. Estrangeiro: E.164 como veio. Inválido: null.
 */
export function canonicalPhone(phone: string | null | undefined): string | null {
  const raw = String(phone ?? "").trim();
  let digits = digitsOnly(raw);
  if (!digits) return null;
  if (!raw.startsWith("+")) {
    if (digits.length === 10 || digits.length === 11) digits = `55${digits}`; // DDD + número
    else if (!(digits.startsWith("55") && (digits.length === 12 || digits.length === 13))) {
      // prefixo de operadora/zero à esquerda etc.: a libphonenumber resolve
      const n = normalizePhone(raw);
      if (!n) return null;
      digits = digitsOnly(n);
    }
  }
  if (digits.length < 8 || digits.length > 15) return null;
  const candidatos = phoneCandidates(digits);
  if (digits.startsWith("55")) {
    // a forma com 9 (13 dígitos) é a canônica; fixo (10 dígitos depois do DDI) só tem uma forma
    return candidatos.find((c) => c.length === 14) ?? candidatos[0];
  }
  return candidatos[0];
}

/** Todas as formas do telefone gravadas na base (com e sem o nono dígito), para consultas `in`. */
export function variantesTelefone(phone: string | null | undefined): string[] {
  const c = canonicalPhone(phone);
  return c ? phoneCandidates(c) : [];
}

/** HMAC-SHA256 do telefone canônico com o salt do tenant (mesmo estilo de hashCPF em masking.ts). */
export function phoneHash(salt: string, phone: string | null | undefined): string | null {
  const c = canonicalPhone(phone);
  return c ? crypto.createHmac("sha256", salt).update(c).digest("hex") : null;
}

async function saltDo(prisma: AppPrismaClient, tenantId: string): Promise<string> {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { cpfSalt: true } });
  if (!t?.cpfSalt) throw new Error(`Tenant ${tenantId} sem cpfSalt`);
  return t.cpfSalt;
}

export interface SuprimirInput {
  telefone?: string | null;
  docHash?: string | null;
  motivo: MotivoSupressao;
  canal?: string | null;
  origem: string;
  pedidoId?: string | null;
  /** data gravada (padrão: agora); a eliminação grava só o dia */
  createdAt?: Date;
}

/**
 * Grava a supressão. Idempotente: se o telefone (e o documento, quando informado) já estão suprimidos pelo
 * mesmo motivo, não cria outra linha. Sem telefone válido nem documento, não faz nada (devolve null).
 */
export async function suprimir(
  prisma: AppPrismaClient,
  tenantId: string,
  input: SuprimirInput
): Promise<{ id: string; criada: boolean; telefoneMasked: string | null } | null> {
  const ph = input.telefone ? phoneHash(await saltDo(prisma, tenantId), input.telefone) : null;
  const dh = input.docHash || null;
  if (!ph && !dh) return null;
  const telefoneMasked = ph ? maskPhone(canonicalPhone(input.telefone)!) : null;

  const existentes = await prisma.supressaoTitular.findMany({
    where: { tenantId, motivo: input.motivo, OR: [...(ph ? [{ phoneHash: ph }] : []), ...(dh ? [{ docHash: dh }] : [])] },
    select: { id: true, phoneHash: true, docHash: true },
  });
  const cobreTelefone = !ph || existentes.some((e) => e.phoneHash === ph);
  const cobreDoc = !dh || existentes.some((e) => e.docHash === dh);
  if (cobreTelefone && cobreDoc && existentes.length) return { id: existentes[0].id, criada: false, telefoneMasked };

  const criada = await prisma.supressaoTitular.create({
    data: {
      tenantId,
      phoneHash: ph,
      docHash: dh,
      motivo: input.motivo,
      canal: input.canal ?? null,
      origem: input.origem,
      pedidoId: input.pedidoId ?? null,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    },
    select: { id: true },
  });
  return { id: criada.id, criada: true, telefoneMasked };
}

/**
 * Motivo da supressão do contato (OPT_OUT | ELIMINACAO | BLOQUEIO) ou null. Além da tabela de supressão,
 * considera o opt-out já gravado nos registros por telefone (Client.optOutAt e CampaignRecipient.optOutAt
 * de QUALQUER registro com esse número), o que cobre os pedidos anteriores à tabela. Mesma regra de
 * `contatoSuprimido` (número reaproveitado com documento próprio passa pela ELIMINACAO do telefone).
 */
export async function estaSuprimido(
  prisma: AppPrismaClient,
  tenantId: string,
  contato: { telefone?: string | null; docHash?: string | null }
): Promise<string | null> {
  const lote = await suprimidosEmLote(prisma, tenantId, { telefones: [contato.telefone], docHashes: [contato.docHash] });
  if (contato.docHash && lote.docHashes.has(contato.docHash)) return lote.motivos.get(`doc:${contato.docHash}`) ?? "OPT_OUT";
  if (!contatoSuprimido(lote, { telefone: contato.telefone, cpfHash: contato.docHash })) return null;
  const c = canonicalPhone(contato.telefone);
  return (c && lote.motivos.get(c)) || "OPT_OUT";
}

export interface LoteSupressao {
  /** telefones canônicos suprimidos */
  telefones: Set<string>;
  docHashes: Set<string>;
  /** motivo por telefone canônico ou por `doc:<hash>` (o que sempre bloqueia tem prioridade sobre ELIMINACAO) */
  motivos: Map<string, string>;
  /** todos os motivos de cada telefone canônico suprimido */
  motivosPorTelefone: Map<string, Set<string>>;
  /** documentos das supressões por ELIMINACAO de cada telefone (null = eliminação sem documento, ex.: lista manual) */
  docsEliminadosPorTelefone: Map<string, Set<string | null>>;
}

const CHUNK = 1000;
const chunks = <T>(xs: T[]) => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK));

/**
 * Versão em lote (envio de campanha, montagem de público): poucas consultas para N contatos, em vez de N.
 * Devolve os telefones (canônicos) e documentos suprimidos.
 */
export async function suprimidosEmLote(
  prisma: AppPrismaClient,
  tenantId: string,
  contatos: { telefones?: (string | null | undefined)[]; docHashes?: (string | null | undefined)[] }
): Promise<LoteSupressao> {
  const out: LoteSupressao = { telefones: new Set(), docHashes: new Set(), motivos: new Map(), motivosPorTelefone: new Map(), docsEliminadosPorTelefone: new Map() };
  const canon = [...new Set((contatos.telefones ?? []).map(canonicalPhone).filter((c): c is string => !!c))];
  const docs = [...new Set((contatos.docHashes ?? []).filter((d): d is string => !!d))];
  if (canon.length === 0 && docs.length === 0) return out;

  const marcarTelefone = (c: string | null, motivo: string, docHash: string | null = null) => {
    if (!c) return;
    out.telefones.add(c);
    // OPT_OUT/BLOQUEIO sempre bloqueiam; ELIMINACAO por telefone não (número reaproveitado): o texto mostra o primeiro
    const atual = out.motivos.get(c);
    if (!atual || (atual === "ELIMINACAO" && motivo !== "ELIMINACAO")) out.motivos.set(c, motivo);
    if (!out.motivosPorTelefone.has(c)) out.motivosPorTelefone.set(c, new Set());
    out.motivosPorTelefone.get(c)!.add(motivo);
    if (motivo === "ELIMINACAO") {
      if (!out.docsEliminadosPorTelefone.has(c)) out.docsEliminadosPorTelefone.set(c, new Set());
      out.docsEliminadosPorTelefone.get(c)!.add(docHash);
    }
  };

  // 1) tabela de supressão (hash do telefone canônico / hash do documento)
  const porHash = new Map<string, string>();
  if (canon.length) {
    const salt = await saltDo(prisma, tenantId);
    for (const c of canon) porHash.set(phoneHash(salt, c)!, c);
  }
  const hashes = [...porHash.keys()];
  for (const parte of chunks([...hashes.map((h) => ({ phoneHash: h })), ...docs.map((d) => ({ docHash: d }))])) {
    const rows = await prisma.supressaoTitular.findMany({ where: { tenantId, OR: parte }, select: { phoneHash: true, docHash: true, motivo: true } });
    for (const r of rows) {
      if (r.phoneHash && porHash.has(r.phoneHash)) marcarTelefone(porHash.get(r.phoneHash)!, r.motivo, r.docHash ?? null);
      if (r.docHash && docs.includes(r.docHash)) {
        out.docHashes.add(r.docHash);
        if (!out.motivos.has(`doc:${r.docHash}`)) out.motivos.set(`doc:${r.docHash}`, r.motivo);
      }
    }
  }

  // 2) opt-out já gravado em qualquer registro com o mesmo número (pedidos anteriores à tabela de supressão)
  const variantes = [...new Set(canon.flatMap((c) => phoneCandidates(c)))];
  for (const parte of chunks(variantes)) {
    const clientes = await prisma.client.findMany({ where: { tenantId, telefone: { in: parte }, optOutAt: { not: null } }, select: { telefone: true } });
    for (const c of clientes) marcarTelefone(canonicalPhone(c.telefone), "OPT_OUT");
    const contatosLista = await prisma.campaignRecipient.findMany({ where: { tenantId, telefone: { in: parte }, optOutAt: { not: null } }, select: { telefone: true } });
    for (const r of contatosLista) marcarTelefone(canonicalPhone(r.telefone), "OPT_OUT");
  }
  return out;
}

/**
 * O contato está no lote de supressão (pelo telefone ou pelo documento)?
 *
 * LGPD 03-01: a ELIMINACAO gravada por TELEFONE não bloqueia um contato com documento (`cpfHash`) próprio,
 * diferente do eliminado e não suprimido: operadoras reaproveitam o número, e o novo dono não pode sumir em
 * silêncio. Ela continua bloqueando o contato sem documento (lista manual) e o próprio documento eliminado.
 * OPT_OUT e BLOQUEIO por telefone bloqueiam sempre.
 */
export function contatoSuprimido(lote: LoteSupressao, contato: { telefone?: string | null; cpfHash?: string | null }): boolean {
  if (contato.cpfHash && lote.docHashes.has(contato.cpfHash)) return true;
  const c = canonicalPhone(contato.telefone);
  if (!c || !lote.telefones.has(c)) return false;
  const motivos = lote.motivosPorTelefone?.get(c);
  if (!motivos || [...motivos].some((m) => m !== "ELIMINACAO")) return true;
  // só eliminação neste número: sem documento, bloqueia; com documento, só se for o próprio eliminado
  if (!contato.cpfHash) return true;
  return lote.docsEliminadosPorTelefone?.get(c)?.has(contato.cpfHash) ?? false;
}

/** Tira da lista quem está suprimido (telefone ou documento). Uma passada em lote, para públicos grandes. */
export async function semSuprimidos<T extends { telefone?: string | null; cpfHash?: string | null }>(
  prisma: AppPrismaClient,
  tenantId: string,
  itens: T[]
): Promise<T[]> {
  if (itens.length === 0) return itens;
  const lote = await suprimidosEmLote(prisma, tenantId, { telefones: itens.map((i) => i.telefone), docHashes: itens.map((i) => i.cpfHash) });
  if (lote.telefones.size === 0 && lote.docHashes.size === 0) return itens;
  return itens.filter((i) => !contatoSuprimido(lote, i));
}

/**
 * LGPD 02-03: registra o pedido para parar de um TELEFONE (WhatsApp, SMS, Z-API): grava a supressão e marca
 * opt-out em TODOS os clientes do tenant com esse número (todas as variantes do nono dígito) e em todos os
 * destinatários de listas manuais. Não grava auditoria (cada canal registra a sua, com o próprio contexto).
 */
export async function registrarOptOutTelefone(
  prisma: AppPrismaClient,
  tenantId: string,
  input: { telefone: string; canal: string; origem: string; quando?: Date }
): Promise<{ clientIds: string[]; telefoneMasked: string | null }> {
  const variantes = variantesTelefone(input.telefone);
  if (variantes.length === 0) return { clientIds: [], telefoneMasked: null };
  const quando = input.quando ?? new Date();
  const sup = await suprimir(prisma, tenantId, { telefone: input.telefone, motivo: "OPT_OUT", canal: input.canal, origem: input.origem });
  const clientes = await prisma.client.findMany({ where: { tenantId, telefone: { in: variantes } }, select: { id: true } });
  const clientIds = clientes.map((c) => c.id);
  if (clientIds.length) {
    // a data do PRIMEIRO pedido é a prova: um "PARAR" repetido não a sobrescreve
    await prisma.client.updateMany({ where: { tenantId, id: { in: clientIds } }, data: { autorizacaoComunicacao: false } });
    await prisma.client.updateMany({ where: { tenantId, id: { in: clientIds }, optOutAt: null }, data: { optOutAt: quando } });
  }
  await prisma.campaignRecipient.updateMany({ where: { tenantId, telefone: { in: variantes }, optOutAt: null }, data: { optOutAt: quando } });
  return { clientIds, telefoneMasked: sup?.telefoneMasked ?? maskPhone(variantes[0]) };
}

/**
 * Filtro Prisma de cliente que PODE receber comunicação: autorizado, sem opt-out e sem bloqueio do
 * tratamento a pedido do titular (LGPD 03-04, `bloqueadoLgpdAt`). A supressão por telefone/documento
 * não cabe num `where` (é hash): quem monta público passa também por `semSuprimidos`.
 */
export const CONTATO_LIBERADO_WHERE = { autorizacaoComunicacao: true, optOutAt: null, bloqueadoLgpdAt: null } as const;

/** Motivo de o cliente não poder receber mensagem (pelo cadastro dele), ou null. */
export function motivoBloqueioCliente(
  client: { autorizacaoComunicacao?: boolean | null; optOutAt?: Date | null; bloqueadoLgpdAt?: Date | null } | null | undefined
): string | null {
  if (!client) return null;
  if (client.bloqueadoLgpdAt) return "Tratamento bloqueado a pedido do titular (LGPD)";
  if (!client.autorizacaoComunicacao || client.optOutAt) return "Cliente sem autorização/opt-out";
  return null;
}

/** Texto do bloqueio por supressão, a partir do motivo gravado. */
export function textoSupressao(motivo: string | null | undefined): string {
  if (motivo === "ELIMINACAO") return "Titular pediu a eliminação dos dados (supressão)";
  if (motivo === "BLOQUEIO") return "Tratamento bloqueado a pedido do titular (supressão)";
  return "Telefone pediu para não receber mensagens (opt-out)";
}

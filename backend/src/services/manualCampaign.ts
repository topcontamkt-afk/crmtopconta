import { AppPrismaClient } from "../config/db";
import { hashDocument, isValidDocument, maskDocument, normalizePhone } from "./masking";
import { normalizeDocumentDigits, parseMoney } from "./purchaseParsing";
import { phoneCandidates } from "./whatsappPayload";
import { usesLimiteDisponivel } from "./messageContext";

/**
 * Campanha manual: o operador sobe uma lista (nome, telefone, CPF, limite disponível) e dispara
 * com um template aprovado da Meta. Os destinatários ficam guardados (CampaignRecipient) para a
 * análise da campanha; quem é cliente da base (achado por CPF, senão por telefone) é ligado ao
 * Client e passa a ser medido pelo uso real, como nas campanhas tradicionais.
 *
 * O "limite disponível" da planilha só aparece na mensagem: nunca altera o saldo do cliente.
 */

export interface ManualRowInput {
  nome?: unknown;
  telefone?: unknown;
  cpf?: unknown;
  limiteDisponivel?: unknown;
}

export interface ParsedManualRow {
  linha: number;
  nome: string;
  telefone: string; // E.164
  cpfHash: string | null;
  cpfMasked: string | null;
  limiteDisponivel: number | null;
}

export interface RejectedManualRow {
  linha: number;
  motivo: string;
}

/** Valida e normaliza as linhas da planilha. Duplicados (mesmo telefone) entram só uma vez. */
export function parseManualRows(rows: ManualRowInput[], cpfSalt: string) {
  const valid: ParsedManualRow[] = [];
  const rejected: RejectedManualRow[] = [];
  const seen = new Set<string>();

  rows.forEach((raw, i) => {
    const linha = i + 1;
    const nome = String(raw.nome ?? "").trim();
    if (!nome) return rejected.push({ linha, motivo: "Sem nome" });

    const telefone = normalizePhone(String(raw.telefone ?? "").trim());
    if (!telefone) return rejected.push({ linha, motivo: "Telefone inválido" });
    if (seen.has(telefone)) return rejected.push({ linha, motivo: "Telefone repetido na lista" });

    let cpfHash: string | null = null;
    let cpfMasked: string | null = null;
    const cpfRaw = String(raw.cpf ?? "").trim();
    if (cpfRaw) {
      const digits = normalizeDocumentDigits(cpfRaw);
      if (!digits || !isValidDocument(digits)) return rejected.push({ linha, motivo: "CPF/CNPJ inválido" });
      cpfHash = hashDocument(digits, cpfSalt);
      cpfMasked = maskDocument(digits);
    }

    let limiteDisponivel: number | null = null;
    const limRaw = raw.limiteDisponivel;
    if (limRaw !== undefined && limRaw !== null && String(limRaw).trim() !== "") {
      const n = parseMoney(limRaw);
      if (n === null || n < 0) return rejected.push({ linha, motivo: "Limite disponível inválido" });
      limiteDisponivel = Math.round(n * 100) / 100;
    }

    seen.add(telefone);
    valid.push({ linha, nome, telefone, cpfHash, cpfMasked, limiteDisponivel });
  });

  return { valid, rejected };
}

export interface ManualAudienceItem extends ParsedManualRow {
  clientId: string | null;
  /** motivo de exclusão do envio (opt-out, bloqueado, comércio credenciado); null = pode enviar */
  excluidoMotivo: string | null;
}

/**
 * Liga cada linha a um cliente da base (CPF primeiro, telefone como reserva, aceitando as duas
 * formas do nono dígito) e marca quem não pode receber: opt-out/sem autorização, conta
 * bloqueada, sem limite (comércio credenciado).
 */
export async function matchManualAudience(prisma: AppPrismaClient, tenantId: string, rows: ParsedManualRow[]): Promise<ManualAudienceItem[]> {
  if (rows.length === 0) return [];
  const select = {
    id: true,
    cpfHash: true,
    telefone: true,
    autorizacaoComunicacao: true,
    optOutAt: true,
    statusConta: true,
    limiteTotal: true,
  } as const;
  type C = { id: string; cpfHash: string; telefone: string; autorizacaoComunicacao: boolean; optOutAt: Date | null; statusConta: string; limiteTotal: unknown };

  const byCpf = new Map<string, C>();
  const byPhone = new Map<string, C>();
  const hashes = rows.map((r) => r.cpfHash).filter((h): h is string => !!h);
  const phoneVariants = [...new Set(rows.flatMap((r) => phoneCandidates(r.telefone)))];

  for (let i = 0; i < hashes.length; i += 2000) {
    const found = await prisma.client.findMany({ where: { tenantId, cpfHash: { in: hashes.slice(i, i + 2000) } }, select });
    for (const c of found) byCpf.set(c.cpfHash, c as C);
  }
  for (let i = 0; i < phoneVariants.length; i += 2000) {
    const found = await prisma.client.findMany({
      where: { tenantId, telefone: { in: phoneVariants.slice(i, i + 2000) } },
      select,
      orderBy: { updatedAt: "desc" },
    });
    for (const c of found) if (!byPhone.has(c.telefone)) byPhone.set(c.telefone, c as C);
  }

  // Quem fora da base já pediu para parar numa lista anterior continua excluído
  const optedOut = new Set(
    (await prisma.campaignRecipient.findMany({ where: { tenantId, optOutAt: { not: null }, telefone: { in: phoneVariants } }, select: { telefone: true } })).map((o) => o.telefone)
  );

  return rows.map((r) => {
    const client = (r.cpfHash ? byCpf.get(r.cpfHash) : undefined) ?? phoneCandidates(r.telefone).map((p) => byPhone.get(p)).find(Boolean) ?? null;
    let excluidoMotivo: string | null = null;
    if (client) {
      if (!client.autorizacaoComunicacao || client.optOutAt) excluidoMotivo = "Cliente em opt-out";
      else if (client.statusConta === "BLOQUEADO") excluidoMotivo = "Conta bloqueada";
      else if (!(Number(client.limiteTotal) > 0)) excluidoMotivo = "Sem limite (comércio credenciado)";
    }
    if (!excluidoMotivo && phoneCandidates(r.telefone).some((p) => optedOut.has(p))) excluidoMotivo = "Pediu para não receber (opt-out)";
    return { ...r, clientId: client?.id ?? null, excluidoMotivo };
  });
}

/**
 * Refaz o vínculo dos destinatários ainda sem cliente: depois de novas importações o contato pode
 * ter entrado na base. Atualiza também os MessageEvents da campanha, para o relatório de uso real
 * enxergá-los. Barato quando não há nada pendente.
 */
export async function linkRecipients(prisma: AppPrismaClient, tenantId: string, campaignId: string): Promise<number> {
  const pending = await prisma.campaignRecipient.findMany({
    where: { tenantId, campaignId, clientId: null },
    select: { id: true, telefone: true, cpfHash: true, nome: true, limiteDisponivel: true, campaignId: true },
  });
  if (pending.length === 0) return 0;

  const matched = await matchManualAudience(
    prisma,
    tenantId,
    pending.map((p, i) => ({ linha: i, nome: p.nome, telefone: p.telefone, cpfHash: p.cpfHash, cpfMasked: null, limiteDisponivel: null }))
  );
  let linked = 0;
  for (let i = 0; i < pending.length; i++) {
    const clientId = matched[i].clientId;
    if (!clientId) continue;
    await prisma.campaignRecipient.update({ where: { id: pending[i].id }, data: { clientId } });
    await prisma.messageEvent.updateMany({ where: { campaignId, recipientId: pending[i].id, clientId: null }, data: { clientId } });
    linked++;
  }
  return linked;
}

/** Valida a lista contra o template e a base: o que será enviado, o que fica de fora e por quê. */
export async function prepareManual(prisma: AppPrismaClient, tenantId: string, rows: ManualRowInput[], templateId: string) {
  const template = await prisma.messageTemplate.findFirst({ where: { id: templateId, tenantId } });
  if (!template || template.channel !== "WHATSAPP") return { error: "Template do WhatsApp não encontrado" as const };
  if (template.status !== "APROVADO") return { error: "Escolha um template aprovado" as const };
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { cpfSalt: true } });

  const { valid, rejected } = parseManualRows(rows, tenant.cpfSalt);
  const needsLimite = usesLimiteDisponivel(template.body);
  const matched = await matchManualAudience(prisma, tenantId, valid);

  const enviar = matched.filter((m) => {
    if (m.excluidoMotivo) {
      rejected.push({ linha: m.linha, motivo: m.excluidoMotivo });
      return false;
    }
    if (needsLimite && m.limiteDisponivel === null) {
      rejected.push({ linha: m.linha, motivo: "Sem limite disponível (o template usa essa variável)" });
      return false;
    }
    return true;
  });
  rejected.sort((a, b) => a.linha - b.linha);
  return { template, enviar, rejected, daBase: enviar.filter((m) => m.clientId).length };
}


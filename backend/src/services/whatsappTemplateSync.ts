import { AppPrismaClient } from "../config/db";
import { explainTemplateIssue, listMetaTemplates, mapMetaStatus, MetaTemplate, TEMPLATE_CATEGORIES } from "./whatsappTemplates";
import { TemplateEvent } from "./whatsappPayload";

/**
 * Mantém o status dos templates locais igual ao da Meta, por webhook (tempo real) e pela
 * sincronização manual. Roda no contexto do tenant dono da conta WhatsApp.
 */
interface MetaState {
  status?: string;
  reason?: string | null;
  category?: string;
  quality?: string;
}

async function findLocal(prisma: AppPrismaClient, tenantId: string, ref: { id: string | null; name: string | null; language: string | null }) {
  const or: any[] = [];
  if (ref.id) or.push({ providerTemplateId: ref.id });
  if (ref.name) or.push({ metaName: ref.name, ...(ref.language ? { language: ref.language } : {}) });
  if (or.length === 0) return null;
  return prisma.messageTemplate.findFirst({ where: { tenantId, channel: "WHATSAPP", OR: or } });
}

async function applyState(prisma: AppPrismaClient, template: { id: string; category: string | null }, s: MetaState) {
  const data: Record<string, unknown> = {};
  if (s.status) {
    data.metaStatus = s.status;
    const local = mapMetaStatus(s.status);
    if (local) data.status = local;
    data.rejectionReason = s.status === "APPROVED" ? null : explainTemplateIssue(s.status, s.reason);
  }
  if (s.quality) data.qualityScore = s.quality;
  // A Meta pode reclassificar (ex.: utilidade -> marketing). Categorias que não usamos (AUTHENTICATION) são ignoradas.
  if (s.category && (TEMPLATE_CATEGORIES as readonly string[]).includes(s.category) && s.category !== template.category) data.category = s.category;
  if (Object.keys(data).length === 0) return false;
  await prisma.messageTemplate.update({ where: { id: template.id }, data });
  return true;
}

export async function applyTemplateEvent(prisma: AppPrismaClient, tenantId: string, ev: TemplateEvent): Promise<boolean> {
  const template = await findLocal(prisma, tenantId, { id: ev.metaTemplateId, name: ev.name, language: ev.language });
  if (!template) return false; // template criado direto no painel da Meta: não existe aqui
  return applyState(prisma, template, { status: ev.status, reason: ev.reason, category: ev.category, quality: ev.quality });
}

export interface SyncResult {
  atualizados: number;
  somenteNaMeta: { name: string; status: string; category: string | null }[];
  total: number;
}

export async function syncTemplatesFromMeta(
  prisma: AppPrismaClient,
  tenantId: string,
  wabaId: string,
  token: string | undefined,
  fetchImpl?: any,
  metaList?: MetaTemplate[]
): Promise<SyncResult> {
  const list = metaList ?? (await listMetaTemplates(wabaId, token, fetchImpl));
  let atualizados = 0;
  const somenteNaMeta: SyncResult["somenteNaMeta"] = [];
  for (const m of list) {
    const local = await findLocal(prisma, tenantId, { id: m.id, name: m.name, language: m.language ?? null });
    if (!local) {
      somenteNaMeta.push({ name: m.name, status: m.status, category: m.category ?? null });
      continue;
    }
    const changed = await applyState(prisma, local, {
      status: m.status,
      reason: m.rejected_reason,
      category: m.category,
      quality: m.quality_score?.score,
    });
    if (changed) atualizados++;
  }
  return { atualizados, somenteNaMeta, total: list.length };
}

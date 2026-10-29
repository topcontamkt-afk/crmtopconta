import { AppPrismaClient } from "../config/db";
import { explainTemplateIssue, listMetaTemplates, mapMetaStatus, MetaTemplate, TEMPLATE_CATEGORIES } from "./whatsappTemplates";
import { TemplateEvent } from "./whatsappPayload";
import { importMetaTemplate, parseMetaDate } from "./templateImport";
import { saveTemplateMedia } from "./mediaStore";

/**
 * Mantém o status dos templates locais igual ao da Meta, por webhook (tempo real) e pela
 * sincronização manual. Roda no contexto do tenant dono da conta WhatsApp.
 */
interface MetaState {
  status?: string;
  reason?: string | null;
  category?: string;
  quality?: string;
  updatedAt?: Date | null;
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
  if (s.updatedAt) data.metaUpdatedAt = s.updatedAt;
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
  /** templates que existiam só na Meta e agora estão no nosso cadastro */
  importados: number;
  /** templates da Meta que não entram aqui (autenticação, reprovados, desativados) */
  somenteNaMeta: { name: string; status: string; category: string | null }[];
  total: number;
}

const NAO_IMPORTAR = new Set(["REJECTED", "DISABLED", "PENDING_DELETION", "DELETED"]);
const IMAGE_MAX = 3 * 1024 * 1024;

/** Baixa a imagem de exemplo do cabeçalho (melhor esforço): serve de imagem padrão de envio. */
async function fetchHeaderImage(url: string, fetchImpl: any): Promise<{ data: Buffer; mime: string } | null> {
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const mime = String(r.headers?.get?.("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (mime !== "image/jpeg" && mime !== "image/png") return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length > 0 && buf.length <= IMAGE_MAX ? { data: buf, mime } : null;
  } catch {
    return null;
  }
}

/** Cria no nosso cadastro um template que só existia na Meta (ver services/templateImport.ts). */
async function importOne(prisma: AppPrismaClient, tenantId: string, m: MetaTemplate, fetchImpl: any) {
  const imp = importMetaTemplate(m);
  const taken = await prisma.messageTemplate.findFirst({ where: { tenantId, channel: "WHATSAPP", name: m.name }, select: { id: true } });
  const created = await prisma.messageTemplate.create({
    data: {
      tenantId,
      channel: "WHATSAPP",
      name: taken ? `${m.name} (Meta)` : m.name,
      body: imp.body,
      status: mapMetaStatus(m.status) ?? "PENDENTE_APROVACAO",
      providerTemplateId: m.id,
      language: imp.language,
      category: imp.category,
      footer: imp.footer,
      quickReplies: imp.quickReplies,
      buttons: imp.buttons as any,
      headerFormat: imp.headerFormat,
      origin: "META",
      metaBody: imp.metaBody,
      variableMap: imp.variableMap as any,
      sendIssue: imp.sendIssue,
      version: 1,
      metaName: m.name,
      metaStatus: m.status,
      qualityScore: m.quality_score?.score ?? null,
      submittedAt: parseMetaDate(m.last_updated_time) ?? new Date(),
      metaUpdatedAt: parseMetaDate(m.last_updated_time),
      rejectionReason: m.status === "APPROVED" ? null : explainTemplateIssue(m.status, m.rejected_reason),
    },
  });
  if (imp.headerFormat === "IMAGE" && imp.headerExampleUrl) {
    const img = await fetchHeaderImage(imp.headerExampleUrl, fetchImpl);
    if (img) {
      await saveTemplateMedia(prisma, tenantId, created.id, { mime: img.mime, filename: `${m.name}.${img.mime === "image/png" ? "png" : "jpg"}`, data: new Uint8Array(img.data) });
    }
  }
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
  let importados = 0;
  const somenteNaMeta: SyncResult["somenteNaMeta"] = [];
  for (const m of list) {
    const local = await findLocal(prisma, tenantId, { id: m.id, name: m.name, language: m.language ?? null });
    if (!local) {
      const category = String(m.category ?? "").toUpperCase();
      if (category === "AUTHENTICATION" || NAO_IMPORTAR.has(String(m.status).toUpperCase())) {
        somenteNaMeta.push({ name: m.name, status: m.status, category: m.category ?? null });
        continue;
      }
      try {
        await importOne(prisma, tenantId, m, fetchImpl ?? fetch);
        importados++;
      } catch (e: any) {
        console.warn(`[templates] não importei ${m.name}:`, e.message);
        somenteNaMeta.push({ name: m.name, status: m.status, category: m.category ?? null });
      }
      continue;
    }
    const changed = await applyState(prisma, local, {
      status: m.status,
      reason: m.rejected_reason,
      category: m.category,
      quality: m.quality_score?.score,
      updatedAt: parseMetaDate(m.last_updated_time),
    });
    if (changed) atualizados++;
  }
  return { atualizados, importados, somenteNaMeta, total: list.length };
}

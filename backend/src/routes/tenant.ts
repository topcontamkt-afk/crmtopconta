import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../middleware/audit";
import { BASES_LEGAIS } from "../services/baseLegal";
import { mencionaOptOut, montarRodape } from "../services/templateVariables";
import { inativosWhere } from "../services/retention";

const router = Router();
router.use(requireAuth);

/** LGPD 04-07: limites do prazo geral de retenção (dias). Fora disso é retenção indefinida ou apagão da base. */
export const RETENCAO_MIN_DIAS = 30;
export const RETENCAO_MAX_DIAS = 1825;

/** GET /api/tenant/settings — configurações operacionais do tenant. */
router.get("/settings", async (req, res) => {
  // findUnique (não findUniqueOrThrow) — um tenantId de um JWT válido para um tenant já
  // removido não deve gerar um P2025 não tratado (500 cru), e sim um 404 genérico.
  const tenant = await prisma.tenant.findUnique({
    where: { id: req.user!.tenantId },
    select: { id: true, name: true, retentionDays: true, maxMsgsPerMinute: true },
  });
  if (!tenant) return res.status(404).json({ error: "Tenant não encontrado" });
  res.json(tenant);
});

const settingsSchema = z.object({
  retentionDays: z.number().int().min(RETENCAO_MIN_DIAS).max(RETENCAO_MAX_DIAS).optional(),
  maxMsgsPerMinute: z.number().int().positive().optional(),
});

/**
 * PUT /api/tenant/settings — rate limit global de envio. LGPD 04-07: o prazo de retenção só muda em
 * PUT /api/tenant/lgpd (com o fundamento e a prévia do impacto); aqui ele só é aceito sem mudança.
 */
router.put("/settings", requireRole("ADMIN"), async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: userId } = req.user!;
  const { retentionDays, ...resto } = parsed.data;
  if (retentionDays !== undefined) {
    const atual = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { retentionDays: true } });
    if (atual && atual.retentionDays !== retentionDays) {
      return res.status(400).json({ error: "O prazo de retenção muda em Configurações → LGPD, com o fundamento do prazo." });
    }
  }

  const tenant = await prisma.tenant.update({ where: { id: tenantId }, data: resto });
  await logAudit({ tenantId, userId, action: "UPDATE_TENANT_SETTINGS", target: "Tenant", targetId: tenantId, details: resto });
  res.json({ id: tenant.id, retentionDays: tenant.retentionDays, maxMsgsPerMinute: tenant.maxMsgsPerMinute });
});

/* ───────────────────────── LGPD 03-06 / 04-07: configuração do controlador ───────────────────────── */

const LGPD_SELECT = {
  id: true,
  name: true,
  baseLegalMarketing: true,
  liaVersao: true,
  liaAprovadaEm: true,
  controladorNome: true,
  encarregadoNome: true,
  encarregadoContato: true,
  avisoPrivacidadeUrl: true,
  rodapeOptOut: true,
  retentionDays: true,
  retentionBasis: true,
  retentionDaysAfterClosure: true,
  inboxRetentionDays: true,
  mediaRetentionDays: true,
  correcaoManualVence: true,
} as const;

type LgpdConfig = Prisma.TenantGetPayload<{ select: typeof LGPD_SELECT }>;

/** Campos de prazo: mudar qualquer um exige o fundamento (`retentionBasis`). */
const CAMPOS_PRAZO = ["retentionDays", "retentionDaysAfterClosure", "inboxRetentionDays", "mediaRetentionDays"] as const;

const textoOpcional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null));

const lgpdSchema = z
  .object({
    baseLegalMarketing: z.enum(BASES_LEGAIS).nullable().optional(),
    liaVersao: textoOpcional(60),
    liaAprovadaEm: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}/, "Data no formato AAAA-MM-DD")
      .nullable()
      .optional()
      .transform((v) => (v === undefined ? undefined : v ? new Date(v.length === 10 ? `${v}T12:00:00Z` : v) : null)),
    controladorNome: textoOpcional(120),
    encarregadoNome: textoOpcional(120),
    encarregadoContato: textoOpcional(200),
    avisoPrivacidadeUrl: textoOpcional(500).refine((v) => !v || /^https:\/\/[^\s]+$/i.test(v), "A URL do aviso de privacidade precisa começar com https://"),
    rodapeOptOut: textoOpcional(160).refine((v) => !v || mencionaOptOut(v), "O rodapé precisa ensinar a parar de receber (ex.: \"Responda SAIR para não receber mais mensagens\")."),
    retentionDays: z.number().int().min(RETENCAO_MIN_DIAS).max(RETENCAO_MAX_DIAS).optional(),
    retentionBasis: textoOpcional(1000),
    retentionDaysAfterClosure: z.number().int().min(RETENCAO_MIN_DIAS).max(RETENCAO_MAX_DIAS).nullable().optional(),
    inboxRetentionDays: z.number().int().min(RETENCAO_MIN_DIAS).max(RETENCAO_MAX_DIAS).nullable().optional(),
    mediaRetentionDays: z.number().int().min(7).max(RETENCAO_MAX_DIAS).optional(),
    correcaoManualVence: z.boolean().optional(),
    // Reduzir o prazo geral anonimiza clientes no próximo job: a tela mostra a prévia e confirma.
    confirmarReducao: z.boolean().optional(),
  })
  .strict();

/** Clientes que a rotina de retenção anonimizaria com o prazo `dias` (mesmo critério de services/retention.ts). */
export function vencidosWhere(tenantId: string, dias: number, agora = new Date()): Prisma.ClientWhereInput {
  // mesmo critério do job de retenção (services/retention.ts), para a prévia não divergir do que será apagado
  return inativosWhere(tenantId, new Date(agora.getTime() - dias * 86_400_000));
}

/** Prévia: quantos clientes já estão vencidos com o prazo atual e quantos ficariam com o novo (só contagem). */
async function previaRetencao(tenantId: string, atual: number, novo: number) {
  const [comAtual, comNovo] = await Promise.all([
    prisma.client.count({ where: vencidosWhere(tenantId, atual) }),
    prisma.client.count({ where: vencidosWhere(tenantId, novo) }),
  ]);
  return { prazoAtual: atual, prazoNovo: novo, vencidosHoje: comAtual, vencidosComNovo: comNovo, aMais: Math.max(0, comNovo - comAtual) };
}

const respostaLgpd = (t: LgpdConfig) => ({
  ...t,
  liaAprovadaEm: t.liaAprovadaEm ? t.liaAprovadaEm.toISOString().slice(0, 10) : null,
  rodapeEfetivo: montarRodape(t),
  limitesRetencao: { min: RETENCAO_MIN_DIAS, max: RETENCAO_MAX_DIAS },
});

/** GET /api/tenant/lgpd — configuração LGPD do controlador (leitura liberada; o assistente e a Inbox usam). */
router.get("/lgpd", async (req, res) => {
  const t = await prisma.tenant.findUnique({ where: { id: req.user!.tenantId }, select: LGPD_SELECT });
  if (!t) return res.status(404).json({ error: "Tenant não encontrado" });
  res.json(respostaLgpd(t));
});

/** GET /api/tenant/lgpd/previa-retencao?dias=N — impacto de mudar o prazo geral (só contagem). ADMIN. */
router.get("/lgpd/previa-retencao", requireRole("ADMIN"), async (req, res) => {
  const dias = Number(req.query.dias);
  if (!Number.isInteger(dias) || dias < RETENCAO_MIN_DIAS || dias > RETENCAO_MAX_DIAS) {
    return res.status(400).json({ error: `Informe o prazo entre ${RETENCAO_MIN_DIAS} e ${RETENCAO_MAX_DIAS} dias.` });
  }
  const t = await prisma.tenant.findUnique({ where: { id: req.user!.tenantId }, select: { retentionDays: true } });
  if (!t) return res.status(404).json({ error: "Tenant não encontrado" });
  res.json(await previaRetencao(req.user!.tenantId, t.retentionDays, dias));
});

/**
 * PUT /api/tenant/lgpd — ADMIN. Base legal de marketing, LIA, controlador, encarregado, aviso de privacidade,
 * rodapé de descadastro e retenção. LGPD 04-07: prazos entre 30 e 1825 dias; mudar um prazo exige o fundamento;
 * reduzir o prazo geral exige `confirmarReducao` quando há clientes a mais para anonimizar. Auditado com os
 * campos alterados (de → para).
 */
router.put("/lgpd", requireRole("ADMIN"), async (req, res) => {
  const parsed = lgpdSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: userId } = req.user!;
  const atual = await prisma.tenant.findUnique({ where: { id: tenantId }, select: LGPD_SELECT });
  if (!atual) return res.status(404).json({ error: "Tenant não encontrado" });

  const { confirmarReducao, ...campos } = parsed.data;
  const data: Record<string, unknown> = {};
  const alterados: Record<string, { de: unknown; para: unknown }> = {};
  const comparavel = (v: unknown) => (v instanceof Date ? v.toISOString() : v ?? null);
  for (const [k, v] of Object.entries(campos)) {
    if (v === undefined) continue;
    const antes = (atual as Record<string, unknown>)[k];
    if (comparavel(antes) === comparavel(v)) continue;
    data[k] = v;
    alterados[k] = { de: comparavel(antes), para: comparavel(v) };
  }
  if (Object.keys(data).length === 0) return res.json(respostaLgpd(atual));

  // o fundamento acompanha toda mudança de prazo (pode ser o mesmo texto, reenviado) e não pode ser apagado
  const mudouPrazo = CAMPOS_PRAZO.some((k) => k in data);
  if (mudouPrazo && (campos.retentionBasis ?? "").length < 10) {
    return res.status(400).json({ error: "Informe o fundamento do prazo (obrigação legal, prazo prescricional ou finalidade), com ao menos 10 caracteres, ao mudar um prazo de retenção.", code: "FUNDAMENTO_OBRIGATORIO" });
  }
  if (campos.retentionBasis === null && atual.retentionBasis) {
    return res.status(400).json({ error: "O fundamento do prazo de retenção não pode ficar vazio." });
  }

  if (typeof data.retentionDays === "number" && data.retentionDays < atual.retentionDays) {
    const previa = await previaRetencao(tenantId, atual.retentionDays, data.retentionDays);
    if (previa.aMais > 0 && confirmarReducao !== true) {
      return res.status(409).json({
        error: `Com ${data.retentionDays} dias, mais ${previa.aMais} cliente(s) serão anonimizados na próxima rotina de retenção. Confirme para salvar.`,
        code: "CONFIRMAR_REDUCAO",
        previa,
      });
    }
  }

  const t = await prisma.tenant.update({ where: { id: tenantId }, data, select: LGPD_SELECT });
  await logAudit({ tenantId, userId, action: "UPDATE_TENANT_LGPD", target: "Tenant", targetId: tenantId, details: { alterados } });
  res.json(respostaLgpd(t));
});

export default router;

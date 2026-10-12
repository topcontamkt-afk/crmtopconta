import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../middleware/audit";
import { cidadeKey, SEM_CIDADE } from "../services/cidades";
import { cicloInfo, diaFechamentoPadrao, formatDiaCivil, hojeBrasilia, validDiaAbertura } from "../services/ciclos";
import { refreshCicloColumns } from "../services/cicloRefresh";
import { ENVIAVEL_WHERE } from "../services/segments";

const router = Router();
router.use(requireAuth);

/** Mensagem sugerida para o público de "ciclo abriu" (só variáveis que o envio preenche: ver templateVariables.ts). */
export const MENSAGEM_CICLO_ABERTO =
  "Olá, {{nome}}! Seu limite do Cartão Top Conta renovou e você já tem {{limite_disponivel}} disponível. Aproveite!";

/** Quem de fato pode receber campanha: com limite, autorizado e sem opt-out. */
const PODE_RECEBER = { ...ENVIAVEL_WHERE, autorizacaoComunicacao: true, optOutAt: null } as const;

async function clientesPorCidade(tenantId: string, onlyEnviaveis: boolean) {
  const rows = await prisma.client.groupBy({
    by: ["cidade"],
    where: { tenantId, ...(onlyEnviaveis ? PODE_RECEBER : {}) },
    _count: { _all: true },
  });
  const map = new Map<string, { label: string; labelN: number; n: number }>();
  for (const r of rows) {
    const key = cidadeKey(r.cidade);
    const cur = map.get(key) ?? { label: r.cidade ?? "", labelN: 0, n: 0 };
    cur.n += r._count._all;
    if (r._count._all > cur.labelN) {
      cur.label = (r.cidade ?? "").trim();
      cur.labelN = r._count._all;
    }
    map.set(key, cur);
  }
  return map;
}

/** GET /api/ciclos — ciclos cadastrados (com a situação de hoje) e cidades da base que ainda não têm ciclo. */
router.get("/", async (req, res) => {
  const { tenantId } = req.user!;
  const hoje = hojeBrasilia();
  const [configs, clientes] = await Promise.all([
    prisma.cicloCidade.findMany({ where: { tenantId }, orderBy: { cidade: "asc" } }),
    clientesPorCidade(tenantId, false),
  ]);
  const configuradas = new Set(configs.map((c) => c.cidadeKey));
  res.json({
    hoje: formatDiaCivil(hoje),
    ciclos: configs.map((c) => {
      const info = cicloInfo(c.diaAbertura, hoje);
      return {
        cidadeKey: c.cidadeKey,
        cidade: c.cidade,
        diaAbertura: c.diaAbertura,
        diaFechamento: c.diaFechamento ?? diaFechamentoPadrao(c.diaAbertura),
        clientes: clientes.get(c.cidadeKey)?.n ?? 0,
        diaDoCiclo: info.diaDoCiclo,
        diasDesdeAbertura: info.diasDesdeAbertura,
        diasParaAbrir: info.diasParaAbrir,
        proximaAbertura: formatDiaCivil(info.proximaAbertura),
      };
    }),
    pendentes: [...clientes.entries()]
      .filter(([key]) => key !== SEM_CIDADE && !configuradas.has(key))
      .map(([key, v]) => ({ cidadeKey: key, cidade: v.label, clientes: v.n }))
      .sort((a, b) => b.clientes - a.clientes),
  });
});

const putSchema = z.object({
  ciclos: z
    .array(
      z.object({
        cidade: z.string().trim().min(1).max(120),
        diaAbertura: z.number().int().min(1).max(31),
        diaFechamento: z.number().int().min(1).max(31).nullable().optional(),
      })
    )
    .max(200),
});

/** PUT /api/ciclos (ADMIN) — grava a tabela inteira de ciclos (a tela envia todas as linhas). */
router.put("/", requireRole("ADMIN"), async (req, res) => {
  const parsed = putSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: userId } = req.user!;

  const byKey = new Map<string, { cidade: string; diaAbertura: number; diaFechamento: number | null }>();
  for (const c of parsed.data.ciclos) {
    const key = cidadeKey(c.cidade);
    if (key === SEM_CIDADE) return res.status(400).json({ error: `"${c.cidade}" não parece o nome de uma cidade` });
    if (!validDiaAbertura(c.diaAbertura)) return res.status(400).json({ error: "Dia de abertura inválido" });
    byKey.set(key, { cidade: c.cidade, diaAbertura: c.diaAbertura, diaFechamento: c.diaFechamento ?? null });
  }

  await prisma.cicloCidade.deleteMany({ where: { tenantId, cidadeKey: { notIn: [...byKey.keys()] } } });
  for (const [key, v] of byKey) {
    await prisma.cicloCidade.upsert({
      where: { tenantId_cidadeKey: { tenantId, cidadeKey: key } },
      create: { tenantId, cidadeKey: key, ...v },
      update: v,
    });
  }
  const atualizados = await refreshCicloColumns(tenantId);
  await logAudit({ tenantId, userId, action: "UPDATE_CICLOS", target: "CicloCidade", targetId: "all", details: { cidades: byKey.size, clientesAtualizados: atualizados } });
  res.json({ ok: true, cidades: byKey.size, clientesAtualizados: atualizados });
});

/**
 * GET /api/ciclos/proximos?dias=7 — cidades que abriram há até 2 dias (limite recém-renovado) ou abrem nos próximos
 * N dias, com quantos clientes podem receber campanha. Alimenta o card do Dashboard.
 */
router.get("/proximos", async (req, res) => {
  const { tenantId } = req.user!;
  const dias = Math.min(31, Math.max(1, Number(req.query.dias) || 7));
  const hoje = hojeBrasilia();
  const [configs, aptos] = await Promise.all([prisma.cicloCidade.findMany({ where: { tenantId } }), clientesPorCidade(tenantId, true)]);

  const lista = configs
    .map((c) => {
      const info = cicloInfo(c.diaAbertura, hoje);
      return {
        cidadeKey: c.cidadeKey,
        cidade: c.cidade,
        diaAbertura: c.diaAbertura,
        abriuHa: info.diasDesdeAbertura,
        abreEm: info.diasParaAbrir,
        proximaAbertura: formatDiaCivil(info.proximaAbertura),
        clientes: aptos.get(c.cidadeKey)?.n ?? 0,
      };
    })
    .filter((c) => c.abriuHa <= 2 || c.abreEm <= dias)
    .sort((a, b) => (a.abriuHa <= 2 ? -1 : 0) - (b.abriuHa <= 2 ? -1 : 0) || a.abreEm - b.abreEm);

  res.json({ hoje: formatDiaCivil(hoje), configurado: configs.length > 0, cidades: lista });
});

/** GET /api/ciclos/audiencia?cidadeKey= — ids de quem pode receber nessa cidade, com a mensagem sugerida (Criar campanha). */
router.get("/audiencia", async (req, res) => {
  const { tenantId } = req.user!;
  const key = String(req.query.cidadeKey ?? "");
  if (!key) return res.status(400).json({ error: "Informe a cidade" });
  const cfg = await prisma.cicloCidade.findFirst({ where: { tenantId, cidadeKey: key } });
  if (!cfg) return res.status(404).json({ error: "Cidade sem ciclo cadastrado" });
  const clientes = await prisma.client.findMany({ where: { tenantId, diaCicloAbertura: cfg.diaAbertura, ...PODE_RECEBER }, select: { id: true, cidade: true } });
  const clientIds = clientes.filter((c) => cidadeKey(c.cidade) === key).map((c) => c.id);
  res.json({ cidade: cfg.cidade, total: clientIds.length, clientIds, mensagem: MENSAGEM_CICLO_ABERTO });
});

export default router;

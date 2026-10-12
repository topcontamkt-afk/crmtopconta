import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../middleware/audit";
import { runRule } from "../services/automationEngine";

const router = Router();
router.use(requireAuth);

/** Regras pré-configuradas suportadas no MVP (PRD — Must have: automação básica). */
export const AUTOMATION_TRIGGERS = [
  "NOVO_CLIENTE_SEM_USO",
  "INATIVO_30_DIAS",
  "LIMITE_RENOVADO",
  "ESTIMULO_FAIXA",
  "OPT_OUT_TELEFONE_INVALIDO",
  "ETAPA_PERFIL",
  "CICLO_ABERTO",
] as const;

router.get("/", async (req, res) => {
  const rules = await prisma.automationRule.findMany({ where: { tenantId: req.user!.tenantId } });
  res.json(rules);
});

const createSchema = z.object({
  name: z.string().min(1),
  trigger: z.enum(AUTOMATION_TRIGGERS),
  condition: z.record(z.any()).optional(),
  action: z.record(z.any()),
  enabled: z.boolean().default(false),
});

router.post("/", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: userId } = req.user!;

  const rule = await prisma.automationRule.create({
    data: { tenantId, ...parsed.data, condition: parsed.data.condition as any, action: parsed.data.action as any },
  });
  await logAudit({ tenantId, userId, action: "CREATE_AUTOMATION", target: "AutomationRule", targetId: rule.id });
  res.status(201).json(rule);
});

router.patch("/:id", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const { tenantId, id: userId } = req.user!;
  const rule = await prisma.automationRule.findFirst({ where: { id: req.params.id, tenantId } });
  if (!rule) return res.status(404).json({ error: "Regra não encontrada" });

  const updated = await prisma.automationRule.update({
    where: { id: rule.id },
    data: { enabled: req.body.enabled ?? rule.enabled, name: req.body.name ?? rule.name },
  });
  // Não loga req.body bruto (sem schema de validação nesta rota, então poderia carregar
  // qualquer campo): só os dois campos realmente aplicados acima — nome da regra e flag de
  // ativação, nenhum dos dois é PII de cliente.
  await logAudit({
    tenantId,
    userId,
    action: "UPDATE_AUTOMATION",
    target: "AutomationRule",
    targetId: rule.id,
    details: { name: updated.name, enabled: updated.enabled },
  });
  res.json(updated);
});

/**
 * POST /api/automations/:id/run — roda a regra agora (a Vercel Hobby só avalia 1x/dia). Com `simular: true`
 * só mostra quantos clientes (e por cidade, no ciclo) casariam, sem enviar nada.
 */
const runSchema = z.object({ simular: z.boolean().default(false) });
router.post("/:id/run", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const parsed = runSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: userId } = req.user!;
  const rule = await prisma.automationRule.findFirst({ where: { id: req.params.id, tenantId } });
  if (!rule) return res.status(404).json({ error: "Regra não encontrada" });
  const result = await runRule(prisma, rule, { simular: parsed.data.simular });
  await logAudit({ tenantId, userId, action: parsed.data.simular ? "SIMULATE_AUTOMATION" : "RUN_AUTOMATION", target: "AutomationRule", targetId: rule.id, details: { matched: result.matched } });
  res.json(result);
});

export default router;

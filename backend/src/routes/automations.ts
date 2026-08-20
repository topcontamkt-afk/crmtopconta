import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../middleware/audit";

const router = Router();
router.use(requireAuth);

/** Regras pré-configuradas suportadas no MVP (PRD — Must have: automação básica). */
export const AUTOMATION_TRIGGERS = [
  "NOVO_CLIENTE_SEM_USO",
  "INATIVO_30_DIAS",
  "LIMITE_RENOVADO",
  "ESTIMULO_FAIXA",
  "OPT_OUT_TELEFONE_INVALIDO",
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
  await logAudit({ tenantId, userId, action: "UPDATE_AUTOMATION", target: "AutomationRule", targetId: rule.id, details: req.body });
  res.json(updated);
});

export default router;

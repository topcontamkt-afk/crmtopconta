import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { prisma } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { logAudit } from "../middleware/audit";
import { ClienteIA, MODELO_PADRAO, responder } from "../services/assistente/assistente";
import { NOMES_FERRAMENTAS } from "../services/assistente/ferramentas";

/**
 * Assistente de dados. Responde SOMENTE com dados reais do sistema (ferramentas de leitura, sem projeção nem estimativa,
 * sem dado pessoal de cliente). Sem ANTHROPIC_API_KEY a rota responde 503 "não configurado". Limite diário por usuário
 * contado na trilha de auditoria (sem tabela nova). A pergunta em si NÃO é gravada na auditoria, só os metadados.
 */
const router = Router();
router.use(requireAuth);

const ACAO_AUDITORIA = "ASSISTENTE_PERGUNTA";
const limiteDiario = () => Math.max(1, Number(process.env.ASSISTENTE_LIMITE_DIARIO) || 50);
const modelo = () => process.env.ASSISTENTE_MODELO?.trim() || MODELO_PADRAO;
const chaveConfigurada = () => !!process.env.ANTHROPIC_API_KEY?.trim();

/** Troca por um cliente falso nos testes. */
let fabricaCliente: () => ClienteIA = () =>
  new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 50_000 }) as unknown as ClienteIA;
export function _definirFabricaDeCliente(f: () => ClienteIA) {
  fabricaCliente = f;
}

async function usadasHoje(tenantId: string, userId: string): Promise<number> {
  return prisma.auditLog.count({ where: { tenantId, userId, action: ACAO_AUDITORIA, createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } } });
}

router.get("/status", async (req, res) => {
  const { tenantId, id: userId } = req.user!;
  res.json({
    configurado: chaveConfigurada(),
    modelo: modelo(),
    limiteDiario: limiteDiario(),
    usadasHoje: await usadasHoje(tenantId, userId),
    ferramentas: NOMES_FERRAMENTAS,
  });
});

const corpoSchema = z
  .object({
    mensagens: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(4000) }).strict()).min(1).max(20),
  })
  .strict();

router.post("/", async (req, res) => {
  const parsed = corpoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Pergunta inválida", codigo: "ENTRADA_INVALIDA" });
  const { mensagens } = parsed.data;
  if (mensagens[0].role !== "user" || mensagens[mensagens.length - 1].role !== "user") {
    return res.status(400).json({ error: "A conversa precisa começar e terminar com uma pergunta", codigo: "ENTRADA_INVALIDA" });
  }
  if (!chaveConfigurada()) {
    return res.status(503).json({ error: "O assistente ainda não foi configurado neste ambiente (falta a chave de IA).", codigo: "NAO_CONFIGURADO" });
  }

  const { tenantId, id: userId, role } = req.user!;
  const usadas = await usadasHoje(tenantId, userId);
  if (usadas >= limiteDiario()) {
    return res.status(429).json({ error: `Limite diário de ${limiteDiario()} perguntas atingido. Tente novamente amanhã.`, codigo: "LIMITE_DIARIO" });
  }

  try {
    const r = await responder({ mensagens, ctx: { tenantId, userId, role, ...contextoDeAcesso(req) }, cliente: fabricaCliente(), modelo: modelo() });
    try {
      await logAudit({
        tenantId,
        userId,
        action: ACAO_AUDITORIA,
        target: "assistente",
        details: { modelo: r.modelo, fim: r.fim, ferramentas: r.ferramentas.map((c) => c.nome), tokens: r.uso, caracteresDaPergunta: mensagens[mensagens.length - 1].content.length },
      });
    } catch (e) {
      console.error("[assistente] falha ao registrar a pergunta na auditoria:", e);
    }
    res.json({ ...r, restantesHoje: Math.max(0, limiteDiario() - usadas - 1) });
  } catch (e) {
    console.error("[assistente] falha ao consultar o modelo:", e instanceof Error ? e.message : e);
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      return res.status(503).json({ error: "O assistente está indisponível: a chave de IA configurada foi recusada.", codigo: "CHAVE_RECUSADA" });
    }
    if (e instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: "O serviço de IA está com muitas requisições. Tente de novo em instantes.", codigo: "LIMITE_PROVEDOR" });
    }
    if (e instanceof Anthropic.APIConnectionTimeoutError) {
      return res.status(504).json({ error: "A consulta demorou demais. Tente uma pergunta mais específica.", codigo: "TEMPO_ESGOTADO" });
    }
    return res.status(502).json({ error: "Não foi possível consultar o assistente agora.", codigo: "FALHA_PROVEDOR" });
  }
});

/** Ponto de extensão do acesso por área (a linhagem da homologação preenche `podeUsar`); aqui vale só o papel. */
function contextoDeAcesso(_req: unknown): { podeUsar?: (area: "dashboard" | "clients" | "campaigns") => boolean } {
  return {};
}

export default router;

import { Router } from "express";
import { prisma } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { AccessProfile, canAccess } from "../services/areas";
import { logAudit } from "../middleware/audit";
import { responder } from "../services/assistente/assistente";
import { configSchema, lerConfig, salvarConfig } from "../services/assistente/config";
import { NOMES_FERRAMENTAS } from "../services/assistente/ferramentas";
import { criarClienteAnthropic, criarProvedorAnthropic } from "../services/assistente/provedores/anthropic";
import { chaveDoProvedor, listarModelos, MODELOS_SUGERIDOS } from "../services/assistente/provedores/modelos";
import { criarProvedorOpenAI } from "../services/assistente/provedores/openai";
import { ErroProvedor, NomeProvedor, PROVEDORES, ProvedorIA, ROTULO_PROVEDOR } from "../services/assistente/provedores/tipos";
import { z } from "zod";

/**
 * Assistente de dados. Responde SOMENTE com dados reais do sistema (ferramentas de leitura, sem projeção nem estimativa,
 * sem dado pessoal de cliente). O provedor (Claude ou GPT) e o modelo são escolhidos em Configurações, por conta; as chaves
 * ficam só no servidor (ANTHROPIC_API_KEY / OPENAI_API_KEY). Sem a chave do provedor escolhido a rota responde 503 "não
 * configurado". Limite diário por usuário contado na trilha de auditoria (sem tabela nova). A pergunta em si NÃO é gravada.
 */
const router = Router();
router.use(requireAuth);

const ACAO_AUDITORIA = "ASSISTENTE_PERGUNTA";
const limiteDiario = () => Math.max(1, Number(process.env.ASSISTENTE_LIMITE_DIARIO) || 50);

/** Troca por um provedor falso nos testes. */
let fabricaProvedor: (nome: NomeProvedor, apiKey: string) => ProvedorIA = (nome, apiKey) =>
  nome === "anthropic" ? criarProvedorAnthropic(criarClienteAnthropic(apiKey)) : criarProvedorOpenAI({ apiKey });
export function _definirFabricaDeProvedor(f: typeof fabricaProvedor) {
  fabricaProvedor = f;
}

async function usadasHoje(tenantId: string, userId: string): Promise<number> {
  return prisma.auditLog.count({ where: { tenantId, userId, action: ACAO_AUDITORIA, createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } } });
}

const infoProvedores = () =>
  PROVEDORES.map((nome) => ({ nome, rotulo: ROTULO_PROVEDOR[nome], chaveConfigurada: !!chaveDoProvedor(nome), sugeridos: MODELOS_SUGERIDOS[nome] }));

router.get("/status", async (req, res) => {
  const { tenantId, id: userId } = req.user!;
  const cfg = await lerConfig(tenantId);
  res.json({
    configurado: !!chaveDoProvedor(cfg.provedor),
    provedor: cfg.provedor,
    rotuloProvedor: ROTULO_PROVEDOR[cfg.provedor],
    modelo: cfg.modelo,
    limiteDiario: limiteDiario(),
    usadasHoje: await usadasHoje(tenantId, userId),
    ferramentas: NOMES_FERRAMENTAS,
  });
});

/** Configuração atual e o que está disponível em cada provedor (sem expor chave nenhuma, só se existe). */
router.get("/config", requireRole("ADMIN"), async (req, res) => {
  const cfg = await lerConfig(req.user!.tenantId);
  res.json({ ...cfg, limiteDiario: limiteDiario(), provedores: infoProvedores() });
});

/** Lista de modelos do provedor, ao vivo pela chave do servidor (com sugestões como reserva). */
router.get("/modelos", requireRole("ADMIN"), async (req, res) => {
  const p = String(req.query.provedor ?? "");
  if (!(PROVEDORES as string[]).includes(p)) return res.status(400).json({ error: "Provedor inválido" });
  res.json(await listarModelos(p as NomeProvedor));
});

router.put("/config", requireRole("ADMIN"), async (req, res) => {
  const parsed = configSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Configuração inválida", codigo: "ENTRADA_INVALIDA" });
  const { tenantId, id: userId } = req.user!;
  try {
    await salvarConfig(tenantId, parsed.data);
  } catch (e) {
    console.error("[assistente] não foi possível salvar a configuração:", e instanceof Error ? e.message : e);
    return res.status(503).json({ error: "Não foi possível salvar: a coluna de configuração ainda não existe no banco (rodar o SQL da atualização).", codigo: "SEM_COLUNA" });
  }
  await logAudit({ tenantId, userId, action: "UPDATE_TENANT_SETTINGS", target: "Tenant", targetId: tenantId, details: { assistente: parsed.data } }).catch((e) =>
    console.error("[assistente] falha ao auditar a configuração:", e)
  );
  res.json({ ...parsed.data, origem: "conta", chaveConfigurada: !!chaveDoProvedor(parsed.data.provedor) });
});

const corpoSchema = z
  .object({
    mensagens: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(4000) }).strict()).min(1).max(20),
  })
  .strict();

const ERROS_PROVEDOR: Record<string, { status: number; erro: (rotulo: string) => string }> = {
  CHAVE_RECUSADA: { status: 503, erro: (r) => `O assistente está indisponível: a chave de ${r} configurada foi recusada.` },
  LIMITE_PROVEDOR: { status: 429, erro: (r) => `${r} está com muitas requisições. Tente de novo em instantes.` },
  TEMPO_ESGOTADO: { status: 504, erro: () => "A consulta demorou demais. Tente uma pergunta mais específica." },
  MODELO_INVALIDO: { status: 400, erro: () => "O modelo escolhido não existe ou a conta não tem acesso a ele. Troque o modelo em Configurações." },
  FALHA_PROVEDOR: { status: 502, erro: () => "Não foi possível consultar o assistente agora." },
};

router.post("/", async (req, res) => {
  const parsed = corpoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Pergunta inválida", codigo: "ENTRADA_INVALIDA" });
  const { mensagens } = parsed.data;
  if (mensagens[0].role !== "user" || mensagens[mensagens.length - 1].role !== "user") {
    return res.status(400).json({ error: "A conversa precisa começar e terminar com uma pergunta", codigo: "ENTRADA_INVALIDA" });
  }

  const { tenantId, id: userId, role } = req.user!;
  const cfg = await lerConfig(tenantId);
  const apiKey = chaveDoProvedor(cfg.provedor);
  if (!apiKey) {
    return res.status(503).json({
      error: `O assistente ainda não foi configurado neste ambiente (falta a chave de ${ROTULO_PROVEDOR[cfg.provedor]}).`,
      codigo: "NAO_CONFIGURADO",
    });
  }

  const usadas = await usadasHoje(tenantId, userId);
  if (usadas >= limiteDiario()) {
    return res.status(429).json({ error: `Limite diário de ${limiteDiario()} perguntas atingido. Tente novamente amanhã.`, codigo: "LIMITE_DIARIO" });
  }

  try {
    const r = await responder({ mensagens, ctx: { tenantId, userId, role, ...(await contextoDeAcesso(tenantId, userId)) }, provedor: fabricaProvedor(cfg.provedor, apiKey), modelo: cfg.modelo });
    try {
      await logAudit({
        tenantId,
        userId,
        action: ACAO_AUDITORIA,
        target: "assistente",
        details: { provedor: r.provedor, modelo: r.modelo, fim: r.fim, ferramentas: r.ferramentas.map((c) => c.nome), tokens: r.uso, caracteresDaPergunta: mensagens[mensagens.length - 1].content.length },
      });
    } catch (e) {
      console.error("[assistente] falha ao registrar a pergunta na auditoria:", e);
    }
    res.json({ ...r, restantesHoje: Math.max(0, limiteDiario() - usadas - 1) });
  } catch (e) {
    console.error("[assistente] falha ao consultar o modelo:", e instanceof Error ? e.message : e);
    const codigo = e instanceof ErroProvedor ? e.codigo : "FALHA_PROVEDOR";
    const m = ERROS_PROVEDOR[codigo] ?? ERROS_PROVEDOR.FALHA_PROVEDOR;
    return res.status(m.status).json({ error: m.erro(ROTULO_PROVEDOR[cfg.provedor]), codigo });
  }
});

/**
 * Acesso por área (como no resto do sistema, ver services/areas.ts): cada ferramenta pertence a uma área e só roda se o
 * usuário a enxerga. Lê o perfil na hora, então mudar as áreas de alguém vale já na próxima pergunta.
 */
async function contextoDeAcesso(tenantId: string, userId: string): Promise<{ podeUsar: (area: "dashboard" | "clients" | "campaigns") => boolean }> {
  const row = await prisma.user.findFirst({ where: { id: userId, tenantId }, select: { role: true, areasRestritas: true, areas: true } });
  if (!row) return { podeUsar: () => false };
  const perfil: AccessProfile = { role: row.role as string, areasRestritas: row.areasRestritas, areas: row.areas };
  return { podeUsar: (area) => canAccess(perfil, [area]) };
}

export default router;

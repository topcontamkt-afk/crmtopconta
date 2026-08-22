import { Request } from "express";
import rateLimit, { Options } from "express-rate-limit";

/**
 * Limitadores de taxa por rota (defesa complementar ao bloqueio de login por tentativas
 * incorretas em services/authSecurity.ts, que é persistido no banco e por isso resiste a
 * cold starts). Todos os limitadores abaixo usam o armazenamento em memória padrão do
 * express-rate-limit, que é POR INSTÂNCIA do processo — não compartilhado entre invocações.
 *
 * Isso é uma limitação conhecida e aceita neste projeto: rodando como função serverless na
 * Vercel (backend/api/index.ts), cada cold start começa com os contadores zerados e invocações
 * concorrentes em instâncias diferentes não compartilham estado, então o limite efetivo pode
 * ser maior do que o configurado sob esse regime. Não há Redis/Upstash (ou qualquer outro store
 * externo) disponível neste projeto para um contador global entre invocações, e o caso de maior
 * risco (força bruta de senha de login) já é coberto de forma consistente entre invocações pelo
 * bloqueio em banco de authSecurity.ts. Os limitadores aqui são uma camada extra de
 * defesa-em-profundidade (2FA, anti-flood de webhooks, throttle de importações), não a defesa
 * primária — se/quando um store compartilhado (ex.: Upstash Redis) for provisionado, basta
 * trocar o `store` de cada limitador abaixo.
 */

const jsonRateLimitHandler: Options["handler"] = (_req, res) => {
  res.status(429).json({ error: "Muitas requisições. Tente novamente mais tarde." });
};

/**
 * POST /api/auth/2fa/verify — código TOTP de 6 dígitos (1.000.000 de combinações). Sem limite,
 * um token pending2FA roubado/adivinhado poderia ser usado para tentar força bruta. Limite
 * apertado por IP: 10 tentativas a cada 15 minutos.
 */
export const twoFactorVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonRateLimitHandler,
});

/**
 * POST /webhooks/whatsapp e POST /webhooks/sms/:provider — endpoints públicos (sem
 * requireAuth), protegidos por verificação de assinatura própria de cada provedor. O limite
 * aqui é só anti-flood (não anti-força-bruta): generoso o bastante para rajadas legítimas de
 * status de mensagens dos provedores, mas evitando que o endpoint público seja usado para
 * inundar o processo/banco. 100 requisições por minuto por IP.
 */
export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonRateLimitHandler,
});

/**
 * Endpoints de importação (routes/imports.ts: POST /google-sheets, /csv, /cartoes,
 * /:id/fix-errors) — autenticados (requireAuth já rodou antes), porém pesados no banco
 * (dedupe, upsert em massa). Limite por usuário (não por IP, já que é uma rota autenticada e
 * vários usuários podem compartilhar IP atrás de um proxy/NAT corporativo) via req.user.id,
 * para impedir que um único usuário martele jobs de importação caros. 20 requisições a cada 10
 * minutos. É a MESMA instância de limiter aplicada em todas essas rotas, então o orçamento de
 * 20 requisições é compartilhado entre elas por usuário (todas disparam o mesmo pipeline caro
 * de importação) — não 20 por rota.
 */
export const importLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  // req.user é preenchido por requireAuth, que roda antes desse limiter em todas as rotas de
  // routes/imports.ts (router.use(requireAuth) no topo do arquivo). Cai para o IP só como
  // fallback defensivo, caso o limiter algum dia seja montado antes do requireAuth.
  keyGenerator: (req: Request) => req.user?.id || req.ip || "unknown",
  handler: jsonRateLimitHandler,
});

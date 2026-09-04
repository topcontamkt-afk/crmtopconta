import "dotenv/config";
// Validação fail-fast de variáveis de ambiente — precisa ser o próximo import depois de
// "dotenv/config" (que carrega o .env local) e antes de qualquer outro módulo que leia
// process.env (rotas, serviços), para travar o processo/cold-start imediatamente com uma
// mensagem clara em vez de falhar de forma obscura só quando a rota afetada for chamada.
import { env } from "./config/env";
import express from "express";
import cors from "cors";
import helmet from "helmet";
// Faz o Express encaminhar automaticamente rejeições de Promise não tratadas dentro de rotas
// async para o error handler abaixo. Sem isso, um erro assíncrono (ex.: falha do Prisma) nunca
// gera resposta — a requisição fica "pendurada" no cliente até a função serverless estourar o
// timeout (300s), em vez de retornar um 500 imediato. Precisa ser importado antes das rotas.
import "express-async-errors";

import authRoutes from "./routes/auth";
import clientRoutes from "./routes/clients";
import dashboardRoutes from "./routes/dashboard";
import importRoutes from "./routes/imports";
import segmentRoutes from "./routes/segments";
import campaignRoutes from "./routes/campaigns";
import automationRoutes from "./routes/automations";
import integrationRoutes from "./routes/integrations";
import auditRoutes from "./routes/audit";
import userRoutes from "./routes/users";
import templateRoutes from "./routes/templates";
import notificationRoutes from "./routes/notifications";
import tenantRoutes from "./routes/tenant";
import cronRoutes from "./routes/cron";

/**
 * Criação do Express app, sem app.listen() nem inicialização do scheduler — para poder ser
 * reutilizado tanto pelo servidor local de longa duração (src/index.ts) quanto pela função
 * serverless da Vercel (api/index.ts, na raiz do pacote backend).
 */
const app = express();
// CORS restrito à allow-list resolvida em config/env.ts (env.ALLOWED_ORIGINS) — nunca reflete
// qualquer origem por padrão. Requisições sem header Origin (server-to-server, curl, apps
// mobile) são permitidas, já que não há origem de navegador a validar.
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || env.ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      const err: Error & { status?: number } = new Error("Origem não permitida pelo CORS");
      err.status = 403;
      return callback(err);
    },
  })
);
// Cabeçalhos de segurança HTTP. API somente-JSON, sem renderização de HTML — a configuração
// padrão do helmet (sem CSP customizada) já cobre o que importa aqui (X-Content-Type-Options,
// HSTS, etc.), então não há necessidade de uma política própria.
app.use(helmet());
app.use(
  express.json({
    limit: "5mb",
    // Guarda os bytes brutos do corpo em req.rawBody antes do parse — necessário para o webhook
    // do WhatsApp (routes/integrations.ts) recomputar o HMAC de X-Hub-Signature-256 sobre o
    // corpo exatamente como recebido (a assinatura da Meta é sobre os bytes crus, não sobre o
    // objeto já parseado/serializado de volta). Não afeta o parse normal de nenhuma outra rota.
    verify: (req, _res, buf) => {
      (req as express.Request).rawBody = buf;
    },
  })
);

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.use("/api/auth", authRoutes);
app.use("/api/clients", clientRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/imports", importRoutes);
app.use("/api/segments", segmentRoutes);
app.use("/api/campaigns", campaignRoutes);
app.use("/api/automations", automationRoutes);
app.use("/api/integrations", integrationRoutes);
app.use("/api/audit-logs", auditRoutes);
app.use("/api/users", userRoutes);
app.use("/api/templates", templateRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/tenant", tenantRoutes);
// Equivalente HTTP do scheduler, para disparo via Vercel Cron Jobs em produção serverless
// (ver src/services/scheduler.ts e routes/cron.ts).
app.use("/api/cron", cronRoutes);

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Rejeição de CORS (ver origin() acima) é esperada, não uma falha do servidor — 403 correto,
  // sem poluir os logs de erro com algo que não é um bug.
  if (err?.status === 403) {
    return res.status(403).json({ error: "Origem não permitida" });
  }
  console.error(err);
  res.status(500).json({ error: "Erro interno do servidor" });
});

export default app;

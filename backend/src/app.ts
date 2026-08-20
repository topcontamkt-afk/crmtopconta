import "dotenv/config";
import express from "express";
import cors from "cors";
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
app.use(cors());
app.use(express.json({ limit: "5mb" }));

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
  console.error(err);
  res.status(500).json({ error: "Erro interno do servidor" });
});

export default app;

import "dotenv/config";
import express from "express";
import cors from "cors";

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
import { startScheduler } from "./services/scheduler";

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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Erro interno do servidor" });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`CRM TopConta API rodando na porta ${PORT}`);
  if (process.env.ENABLE_SCHEDULER !== "false") {
    startScheduler();
  }
});

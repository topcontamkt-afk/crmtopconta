import app from "./app";
import { startScheduler } from "./services/scheduler";

/**
 * Entrypoint do servidor de longa duração (dev local, ou hospedagem tipo Railway/Render).
 * Em produção serverless (Vercel) este arquivo NÃO é usado — a função em api/index.ts importa
 * ./app diretamente, e os jobs periódicos rodam via Vercel Cron Jobs (routes/cron.ts) em vez
 * do node-cron em processo iniciado aqui.
 */
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`CRM TopConta API rodando na porta ${PORT}`);
  if (process.env.ENABLE_SCHEDULER !== "false") {
    startScheduler();
  }
});

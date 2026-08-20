import { NextFunction, Request, Response } from "express";

/**
 * Protege os endpoints /api/cron/* que substituem o scheduler em-processo (node-cron) quando
 * o backend roda como função serverless (Vercel) — lá, "Vercel Cron Jobs" chama esses endpoints
 * HTTP no lugar de um loop contínuo. Exige um segredo compartilhado (CRON_SECRET) para que
 * ninguém além do disparador de cron configurado consiga acionar esses jobs.
 */
export function requireCronSecret(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return res.status(500).json({ error: "CRON_SECRET não configurado no ambiente" });
  }

  // Vercel Cron Jobs envia "Authorization: Bearer <CRON_SECRET>" quando configurado com esse
  // header nas definições do vercel.json; aceitamos também um header próprio como fallback
  // para disparo manual/teste (ex.: curl, ou outro agendador externo).
  const authHeader = req.headers.authorization;
  const headerSecret = req.headers["x-cron-secret"];
  const provided = authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : headerSecret;

  if (provided !== secret) {
    return res.status(401).json({ error: "Não autorizado" });
  }
  next();
}

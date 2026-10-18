import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../config/db";
import { env } from "../config/env";
import { runWithTenantContextAsync } from "../config/tenantGuard";
import { areaForRequest, canAccess, AccessProfile } from "../services/areas";

/**
 * Confere o ACESSO POR ÁREA em toda chamada de /api (mapa em services/areas.ts). Roda antes das rotas:
 * lê o JWT por conta própria e busca o perfil de acesso no banco, então trocar as áreas de alguém vale em
 * poucos segundos (sem esperar o token de 12 h vencer). Sem token ou token inválido não decide nada: a
 * rota responde 401 pelo requireAuth de sempre. Também barra quem foi desativado.
 */
const TTL_MS = 15_000;
const cache = new Map<string, { at: number; profile: (AccessProfile & { active: boolean }) | null }>();

/** Esquece o perfil em cache (usado ao mudar acessos nesta mesma instância). */
export function invalidateAccessCache(userId?: string) {
  if (userId) cache.delete(userId);
  else cache.clear();
}

async function loadProfile(userId: string, tenantId: string) {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.profile;
  const row = await runWithTenantContextAsync(tenantId, () =>
    prisma.user.findFirst({ where: { id: userId, tenantId }, select: { role: true, active: true, areasRestritas: true, areas: true } })
  );
  const profile = row ? { role: row.role as string, active: row.active, areasRestritas: row.areasRestritas, areas: row.areas } : null;
  cache.set(userId, { at: Date.now(), profile });
  return profile;
}

export async function areaAccess(req: Request, res: Response, next: NextFunction) {
  const required = areaForRequest(req.method, req.path);
  // Usuário desativado é barrado em toda rota autenticada, não só nas que têm área: o requireAuth só
  // confere o JWT (12 h), então era aqui o único lugar que olhava `active` (LGPD 05-07).
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return next();
  let payload: any;
  try {
    payload = jwt.verify(header.substring(7), env.JWT_SECRET, { algorithms: ["HS256"] });
  } catch {
    return next();
  }
  if (payload.pending2FA || !payload.sub || !payload.tenantId) return next();
  try {
    const profile = await loadProfile(payload.sub, payload.tenantId);
    if (!profile || !profile.active) return res.status(401).json({ error: "Usuário desativado ou inexistente" });
    if (required && !canAccess(profile, required)) return res.status(403).json({ error: "Você não tem acesso a esta área do sistema", codigo: "SEM_ACESSO_AREA" });
    return next();
  } catch (e) {
    console.error("[areaAccess] falha ao conferir o acesso:", e);
    return res.status(503).json({ error: "Não foi possível conferir o acesso. Tente de novo." });
  }
}

import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { runWithTenantContext } from "../config/tenantGuard";

// Sem fallback: config/env.ts já falha o boot do processo se JWT_SECRET estiver ausente, então
// nunca existe um caminho de execução em que este valor não esteja definido.
const JWT_SECRET = env.JWT_SECRET;

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token ausente" });
  }
  try {
    const payload = jwt.verify(header.substring(7), JWT_SECRET) as any;
    // Token intermediário emitido entre "senha correta" e "código 2FA confirmado" — nunca deve
    // ser aceito como autenticação completa em nenhuma rota protegida.
    if (payload.pending2FA) {
      return res.status(401).json({ error: "Verificação de dois fatores pendente" });
    }
    req.user = { id: payload.sub, tenantId: payload.tenantId, role: payload.role, email: payload.email };
    // RLS real (config/tenantGuard.ts): toda query feita pelo resto da cadeia de middlewares/rota
    // precisa desse tenantId disponível via AsyncLocalStorage para setar a GUC `app.tenant_id`
    // que as policies do Postgres leem — sem isso, toda query veria zero linhas.
    runWithTenantContext(req.user.tenantId, next);
  } catch {
    return res.status(401).json({ error: "Token inválido ou expirado" });
  }
}

/** Controle de acesso por função (RBAC). */
export function requireRole(...roles: Array<"ADMIN" | "OPERATOR" | "ANALYST" | "VIEWER">) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Permissão insuficiente para esta ação" });
    }
    next();
  };
}

export function signToken(user: { id: string; tenantId: string; role: string; email: string }) {
  return jwt.sign(
    { sub: user.id, tenantId: user.tenantId, role: user.role, email: user.email },
    JWT_SECRET,
    { expiresIn: "12h" }
  );
}

/** Token de curta duração emitido após senha correta, quando o usuário tem 2FA ativo — só serve
 * para chamar POST /api/auth/2fa/verify, nunca para acessar rotas protegidas normais. */
export function signPending2FAToken(userId: string) {
  return jwt.sign({ sub: userId, pending2FA: true }, JWT_SECRET, { expiresIn: "5m" });
}

export function verifyPending2FAToken(token: string): string {
  const payload = jwt.verify(token, JWT_SECRET) as any;
  if (!payload.pending2FA || !payload.sub) throw new Error("Token de verificação 2FA inválido");
  return payload.sub as string;
}

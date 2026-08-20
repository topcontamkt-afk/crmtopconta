import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token ausente" });
  }
  try {
    const payload = jwt.verify(header.substring(7), JWT_SECRET) as any;
    req.user = { id: payload.sub, tenantId: payload.tenantId, role: payload.role, email: payload.email };
    next();
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

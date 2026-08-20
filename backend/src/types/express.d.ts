import "express";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        tenantId: string;
        role: "ADMIN" | "OPERATOR" | "ANALYST" | "VIEWER";
        email: string;
      };
    }
  }
}

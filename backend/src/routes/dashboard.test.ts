import express from "express";
import request from "supertest";

const rawQuery = jest.fn();
jest.mock("../config/db", () => ({ prisma: {}, tenantRaw: { query: (...a: any[]) => rawQuery(...a), execute: jest.fn() } }));
jest.mock("../middleware/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: "u1", tenantId: "t1", role: "VIEWER" };
    next();
  },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));
jest.mock("../middleware/audit", () => ({ logAudit: jest.fn(async () => undefined) }));

import router from "./dashboard";
import { logAudit } from "../middleware/audit";

const app = express();
app.use(express.json());
app.use("/dashboard", router);

describe("LGPD 01-04: GET /dashboard/engajamento (aniversariantes)", () => {
  it("telefone mascarado, sem bloqueados e com trilha só da quantidade", async () => {
    rawQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("GROUP BY nivel")) return [{ nivel: "alto", count: BigInt(3) }];
      if (sql.includes("COUNT(*)")) return [{ count: BigInt(1) }];
      return [{ id: "c1", nome: "Maria", telefone: "+5584999998888", cidade: "Natal", dia: 5 }];
    });
    const r = await request(app).get("/dashboard/engajamento");
    expect(r.status).toBe(200);
    expect(r.body.aniversariantes.itens[0].telefone).toBe("*********8888");
    expect(JSON.stringify(r.body)).not.toContain("+5584999998888");
    const listaSql = rawQuery.mock.calls.map((c) => c[0] as string).find((s) => s.includes("LIMIT 100"))!;
    expect(listaSql).toContain('"bloqueadoLgpdAt" IS NULL');
    const a = (logAudit as jest.Mock).mock.calls[0][0];
    expect(a).toMatchObject({ action: "READ_ANIVERSARIANTES", details: { quantidade: 1 } });
    expect(JSON.stringify(a)).not.toContain("Maria");
  });
});

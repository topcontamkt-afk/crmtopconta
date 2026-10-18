import express from "express";
import request from "supertest";

const db = {
  pedidoTitular: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  client: { findMany: jest.fn(async () => []), findFirst: jest.fn() },
};
jest.mock("../config/db", () => ({ prisma: db }));
jest.mock("../middleware/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: "u1", tenantId: "t1", role: (req.headers["x-role"] as string) || "OPERATOR" };
    next();
  },
  requireRole: (...roles: string[]) => (req: any, res: any, next: any) => (roles.includes(req.user.role) ? next() : res.status(403).json({ error: "Sem permissão" })),
}));
jest.mock("../middleware/audit", () => ({ logAudit: jest.fn(async () => undefined) }));

import router from "./titular";
import { logAudit } from "../middleware/audit";

const app = express();
app.use(express.json());
app.use("/titular/pedidos", router);
const audit = logAudit as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe("LGPD 03-05: pedidos de titular", () => {
  it("cria com prazo de 15 dias, telefone só mascarado e auditoria sem texto livre", async () => {
    db.client.findFirst.mockResolvedValue({ id: "11111111-1111-4111-8111-111111111111", telefone: "+5584999998888" });
    db.pedidoTitular.create.mockImplementation(async ({ data }: any) => ({ id: "p1", ...data }));
    const r = await request(app)
      .post("/titular/pedidos")
      .send({ clientId: "11111111-1111-4111-8111-111111111111", tipo: "ACESSO", canal: "WHATSAPP", descricao: "Quero meus dados, sou Maria", recebidoEm: "2026-10-01T12:00:00.000Z" });
    expect(r.status).toBe(201);
    const data = db.pedidoTitular.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ tenantId: "t1", telefoneMasked: "*********8888", userId: "u1" });
    expect(data.prazoEm.toISOString()).toBe("2026-10-16T12:00:00.000Z");
    expect(db.client.findFirst.mock.calls[0][0].where.tenantId).toBe("t1");
    expect(audit.mock.calls[0][0]).toMatchObject({ action: "CREATE_PEDIDO_TITULAR", targetId: "p1" });
    expect(JSON.stringify(audit.mock.calls[0][0])).not.toContain("Maria");
  });

  it("VIEWER/ANALYST não leem nem criam; tipo inválido é recusado", async () => {
    expect((await request(app).get("/titular/pedidos").set("x-role", "VIEWER")).status).toBe(403);
    expect((await request(app).post("/titular/pedidos").set("x-role", "ANALYST").send({ tipo: "ACESSO", canal: "EMAIL" })).status).toBe(403);
    expect((await request(app).post("/titular/pedidos").send({ tipo: "XPTO", canal: "EMAIL" })).status).toBe(400);
  });

  it("lista por tenant, com vencidos no topo e contados", async () => {
    const passado = new Date(Date.now() - 86_400_000);
    const futuro = new Date(Date.now() + 5 * 86_400_000);
    db.pedidoTitular.findMany.mockResolvedValue([
      { id: "a", status: "ABERTO", prazoEm: futuro, clientId: null },
      { id: "f", status: "ATENDIDO", prazoEm: passado, clientId: null },
      { id: "v", status: "ABERTO", prazoEm: passado, clientId: null },
    ]);
    const r = await request(app).get("/titular/pedidos");
    expect(r.status).toBe(200);
    expect(db.pedidoTitular.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
    expect(r.body.itens.map((p: any) => p.id)).toEqual(["v", "a", "f"]);
    expect(r.body.vencidos).toBe(1);
    expect(r.body.itens[0].vencido).toBe(true);
    expect(r.body.itens[2].vencido).toBe(false);
  });

  it("só ADMIN fecha, com resposta; pedido já fechado dá 409", async () => {
    expect((await request(app).post("/titular/pedidos/p1/fechar").send({ status: "ATENDIDO", resposta: "Enviado o relatório" })).status).toBe(403);
    expect((await request(app).post("/titular/pedidos/p1/fechar").set("x-role", "ADMIN").send({ status: "ATENDIDO" })).status).toBe(400);

    db.pedidoTitular.findFirst.mockResolvedValue({ id: "p1", status: "ABERTO", tipo: "ACESSO", prazoEm: new Date(Date.now() + 86_400_000) });
    db.pedidoTitular.update.mockImplementation(async ({ data }: any) => ({ id: "p1", ...data }));
    const r = await request(app).post("/titular/pedidos/p1/fechar").set("x-role", "ADMIN").send({ status: "NEGADO", resposta: "Dado necessário para obrigação legal" });
    expect(r.status).toBe(200);
    expect(db.pedidoTitular.findFirst.mock.calls[0][0].where).toEqual({ id: "p1", tenantId: "t1" });
    expect(db.pedidoTitular.update.mock.calls[0][0].data.respondidoEm).toBeInstanceOf(Date);
    expect(audit.mock.calls[0][0]).toMatchObject({ action: "CLOSE_PEDIDO_TITULAR", details: { status: "NEGADO", noPrazo: true } });

    db.pedidoTitular.findFirst.mockResolvedValue({ id: "p1", status: "ATENDIDO", tipo: "ACESSO", prazoEm: new Date() });
    expect((await request(app).post("/titular/pedidos/p1/fechar").set("x-role", "ADMIN").send({ status: "ATENDIDO", resposta: "de novo" })).status).toBe(409);
  });
});

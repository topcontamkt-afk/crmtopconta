import express from "express";
import request from "supertest";

const db = {
  conversation: { count: jest.fn(async () => 2), findFirst: jest.fn(), findMany: jest.fn(async (_a: any) => [] as any[]) },
};
jest.mock("../config/db", () => ({ prisma: db }));
jest.mock("../middleware/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: "u1", tenantId: "t1", role: "OPERATOR" };
    next();
  },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));
jest.mock("../middleware/audit", () => ({ logAudit: jest.fn(async () => undefined) }));

import router from "./inbox";

const app = express();
app.use(express.json());
app.use("/inbox", router);

beforeEach(() => jest.clearAllMocks());

describe("LGPD 07-05: resumo do aviso de mensagem nova", () => {
  it("não devolve nome nem trecho da mensagem, só id e horário", async () => {
    const em = new Date("2026-10-18T10:00:00Z");
    db.conversation.findFirst.mockImplementation(async (args: any) =>
      args.select ? { id: "cv1", lastInboundAt: em } : { id: "cv1", lastInboundAt: em, contactName: "Maria", lastPreview: "meu saldo", client: { nome: "Maria" } }
    );
    const r = await request(app).get("/inbox/resumo");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ naoLidas: 2, ultima: { id: "cv1", em: em.toISOString() } });
    expect(JSON.stringify(r.body)).not.toMatch(/Maria|saldo/);
  });
});

describe("LGPD 07-03: busca de conversas fora da URL", () => {
  it("GET com ?busca= é recusado com 400", async () => {
    const r = await request(app).get("/inbox/conversations?busca=Maria");
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/POST \/api\/inbox\/conversations\/search/);
    expect(db.conversation.findMany).not.toHaveBeenCalled();
  });

  it("GET sem busca continua funcionando com filtros", async () => {
    const r = await request(app).get("/inbox/conversations?filtro=nao_lidas");
    expect(r.status).toBe(200);
    expect(db.conversation.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", unreadCount: { gt: 0 } });
  });

  it("POST /conversations/search leva o termo no corpo", async () => {
    const r = await request(app).post("/inbox/conversations/search").send({ filtro: "todas", busca: "Maria" });
    expect(r.status).toBe(200);
    const where = db.conversation.findMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe("t1");
    expect(JSON.stringify(where.AND)).toContain("Maria");
  });
});

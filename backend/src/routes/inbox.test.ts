import express from "express";
import request from "supertest";

const db = {
  conversation: { count: jest.fn(async () => 2), findFirst: jest.fn(), findMany: jest.fn(async (_a: any) => [] as any[]) },
  whatsAppAccount: { findFirst: jest.fn(), update: jest.fn(async () => ({})) },
  tenant: { findUnique: jest.fn() },
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

describe("LGPD 02-06: conversa da Z-API segue a janela de 24h", () => {
  const conversa = (lastInboundAt: Date) => ({
    id: "cv1", waId: "5579999990000", contactName: "Contato", lastInboundAt, unreadCount: 0, status: "ABERTA",
    lastMessageAt: lastInboundAt, lastPreview: null, client: null, account: { provider: "ZAPI" },
  });

  it("lista: conversa Z-API sem mensagem nas últimas 24h aparece com a janela fechada", async () => {
    db.conversation.findMany.mockResolvedValueOnce([conversa(new Date(Date.now() - 30 * 3600_000))]);
    const r = await request(app).get("/inbox/conversations");
    expect(r.status).toBe(200);
    expect(r.body.conversas[0].janelaAberta).toBe(false);
  });

  it("lista: filtro janela_aberta não inclui toda conversa Z-API", async () => {
    await request(app).get("/inbox/conversations?filtro=janela_aberta");
    const where = db.conversation.findMany.mock.calls[0][0].where;
    expect(where.OR).toBeUndefined();
    expect(where.lastInboundAt.gte).toBeInstanceOf(Date);
  });
});

describe("LGPD 02-08: resposta automática mostra o texto do controlador deste tenant", () => {
  beforeEach(() => {
    db.whatsAppAccount.findFirst.mockResolvedValue({ id: "wa1", autoReplyEnabled: true, autoReplyText: null });
    db.tenant.findUnique.mockResolvedValue({ name: "T", controladorNome: "Empresa X", encarregadoNome: "Ana", encarregadoContato: "dpo@x.com" });
  });

  it("GET devolve o padrão com o controlador e a instrução de SAIR, sem o telefone fixo antigo", async () => {
    const r = await request(app).get("/inbox/auto-reply");
    expect(r.status).toBe(200);
    expect(r.body.padrao).toContain("Empresa X");
    expect(r.body.padrao).toContain("dpo@x.com");
    expect(r.body.texto).toBe(r.body.padrao);
    expect(r.body.texto).toMatch(/SAIR/);
    expect(db.tenant.findUnique.mock.calls[0][0].where).toEqual({ id: "t1" });
  });

  it("PUT com o texto igual ao padrão do controlador grava nulo (segue o padrão se a config mudar)", async () => {
    const g = await request(app).get("/inbox/auto-reply");
    await request(app).put("/inbox/auto-reply").send({ ativa: true, texto: g.body.padrao });
    expect((db.whatsAppAccount.update.mock.calls as any[])[0][0].data).toEqual({ autoReplyEnabled: true, autoReplyText: null });
  });

  it("PUT grava máximo e janela e recusa valores fora da faixa", async () => {
    const ok = await request(app).put("/inbox/auto-reply").send({ ativa: true, texto: "Oi", maximo: 5, janelaHoras: 12 });
    expect(ok.status).toBe(200);
    expect((db.whatsAppAccount.update.mock.calls as any[]).at(-1)[0].data).toMatchObject({ autoReplyMax: 5, autoReplyJanelaHoras: 12 });
    expect((await request(app).put("/inbox/auto-reply").send({ ativa: true, texto: "Oi", maximo: 0 })).status).toBe(400);
    expect((await request(app).put("/inbox/auto-reply").send({ ativa: true, texto: "Oi", janelaHoras: 100 })).status).toBe(400);
  });

  it("GET devolve o padrão 3 por 24 h quando a conta não configurou", async () => {
    const r = await request(app).get("/inbox/auto-reply");
    expect(r.body).toMatchObject({ maximo: 3, janelaHoras: 24 });
  });
});

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
const registrarOptOutTelefone = jest.fn(async (..._a: any[]) => ({ clientIds: ["c1"], telefoneMasked: "*********8888" }));
jest.mock("../services/privacy", () => ({ registrarOptOutTelefone: (...a: any[]) => registrarOptOutTelefone(...a) }));
const anonymizeContato = jest.fn();
jest.mock("../services/retention", () => ({ anonymizeContato: (...a: any[]) => anonymizeContato(...a) }));
const relatorioContato = jest.fn();
jest.mock("../services/titular", () => ({ ...jest.requireActual("../services/titular"), relatorioContato: (...a: any[]) => relatorioContato(...a) }));

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

describe("LGPD 02-09: atender revogação ou oposição descadastra o número", () => {
  const aberto = (over: any = {}) => ({ id: "p1", status: "ABERTO", tipo: "REVOGACAO", canal: "TELEFONE", clientId: "c1", prazoEm: new Date(Date.now() + 86_400_000), ...over });
  beforeEach(() => db.pedidoTitular.update.mockImplementation(async ({ data }: any) => ({ id: "p1", ...data })));

  it("com cliente ligado: opt-out pelo telefone do cadastro antes de fechar, auditado sem o número", async () => {
    db.pedidoTitular.findFirst.mockResolvedValue(aberto());
    db.client.findFirst.mockResolvedValue({ telefone: "+5584999998888" });
    const r = await request(app).post("/titular/pedidos/p1/fechar").set("x-role", "ADMIN").send({ status: "ATENDIDO", resposta: "Descadastrado" });
    expect(r.status).toBe(200);
    expect(db.client.findFirst.mock.calls[0][0].where).toEqual({ id: "c1", tenantId: "t1" });
    expect(registrarOptOutTelefone).toHaveBeenCalledWith(db, "t1", { telefone: "+5584999998888", canal: "TELEFONE", origem: "pedido_titular" });
    expect(audit.mock.calls[0][0].details).toMatchObject({ tipo: "REVOGACAO", optOut: { clientes: 1 } });
    expect(JSON.stringify(audit.mock.calls[0][0])).not.toContain("8888");
  });

  it("fora da base: exige o telefone (400) e, com ele, descadastra o número normalizado", async () => {
    db.pedidoTitular.findFirst.mockResolvedValue(aberto({ tipo: "OPOSICAO", clientId: null }));
    const sem = await request(app).post("/titular/pedidos/p1/fechar").set("x-role", "ADMIN").send({ status: "ATENDIDO", resposta: "Feito" });
    expect(sem.status).toBe(400);
    expect(sem.body.code).toBe("TELEFONE_OBRIGATORIO");
    expect(db.pedidoTitular.update).not.toHaveBeenCalled();
    const com = await request(app).post("/titular/pedidos/p1/fechar").set("x-role", "ADMIN").send({ status: "ATENDIDO", resposta: "Feito", telefone: "(84) 99999-8888" });
    expect(com.status).toBe(200);
    expect(registrarOptOutTelefone.mock.calls[0][2]).toMatchObject({ telefone: "+5584999998888" });
  });

  it("negado ou outro tipo de pedido: não mexe no opt-out", async () => {
    db.pedidoTitular.findFirst.mockResolvedValue(aberto());
    await request(app).post("/titular/pedidos/p1/fechar").set("x-role", "ADMIN").send({ status: "NEGADO", resposta: "Obrigação legal" });
    db.pedidoTitular.findFirst.mockResolvedValue(aberto({ id: "p2", tipo: "ACESSO" }));
    await request(app).post("/titular/pedidos/p2/fechar").set("x-role", "ADMIN").send({ status: "ATENDIDO", resposta: "Relatório enviado" });
    expect(registrarOptOutTelefone).not.toHaveBeenCalled();
  });
});

describe("LGPD 03-09: pedido de quem não é cliente da base", () => {
  const pedido = (over: any = {}) => ({ id: "p1", status: "ABERTO", tipo: "ELIMINACAO", canal: "WHATSAPP", clientId: null, prazoEm: new Date(Date.now() + 86_400_000), ...over });
  const resultado = { supressaoGravada: true, removidos: { midias: 1 }, anonimizados: { conversas: 1, mensagensInbox: 2, destinatarios: 1, mensagensCampanha: 1 }, copiasExternas: [] };
  beforeEach(() => db.pedidoTitular.update.mockImplementation(async ({ data }: any) => ({ id: "p1", ...data })));

  it("fechar eliminação como atendida sem eliminar: 409 (fora da base e cliente ainda não anonimizado)", async () => {
    db.pedidoTitular.findFirst.mockResolvedValue(pedido());
    const fora = await request(app).post("/titular/pedidos/p1/fechar").set("x-role", "ADMIN").send({ status: "ATENDIDO", resposta: "Apagado" });
    expect(fora.status).toBe(409);
    expect(fora.body.code).toBe("USE_ELIMINAR_CONTATO");
    db.pedidoTitular.findFirst.mockResolvedValue(pedido({ clientId: "c1" }));
    db.client.findFirst.mockResolvedValue({ anonymizedAt: null });
    const ficha = await request(app).post("/titular/pedidos/p1/fechar").set("x-role", "ADMIN").send({ status: "ATENDIDO", resposta: "Apagado" });
    expect(ficha.body.code).toBe("USE_ELIMINACAO_FICHA");
    expect(db.pedidoTitular.update).not.toHaveBeenCalled();
    // negar continua possível (ex.: obrigação legal de guarda)
    db.pedidoTitular.findFirst.mockResolvedValue(pedido());
    expect((await request(app).post("/titular/pedidos/p1/fechar").set("x-role", "ADMIN").send({ status: "NEGADO", resposta: "Obrigação legal" })).status).toBe(200);
  });

  it("eliminar-contato: só ADMIN, exige a frase; elimina pelo telefone do corpo e fecha o pedido sem texto livre", async () => {
    db.pedidoTitular.findFirst.mockResolvedValue(pedido());
    expect((await request(app).post("/titular/pedidos/p1/eliminar-contato").send({ telefone: "84977776666", confirmacao: "ELIMINAR DADOS" })).status).toBe(403);
    expect((await request(app).post("/titular/pedidos/p1/eliminar-contato").set("x-role", "ADMIN").send({ telefone: "84977776666" })).status).toBe(400);
    anonymizeContato.mockResolvedValue(resultado);
    const r = await request(app).post("/titular/pedidos/p1/eliminar-contato").set("x-role", "ADMIN").send({ telefone: "84977776666", confirmacao: "ELIMINAR DADOS" });
    expect(r.status).toBe(200);
    expect(anonymizeContato.mock.calls[0][1]).toBe("t1");
    expect(anonymizeContato.mock.calls[0][2]).toBe("84977776666");
    expect(db.pedidoTitular.update.mock.calls[0][0].data).toMatchObject({ status: "ATENDIDO", descricao: null, telefoneMasked: null });
  });

  it("eliminar-contato: número de cliente da base → 409 com o id; pedido de cliente ou de outro tipo → 409", async () => {
    db.pedidoTitular.findFirst.mockResolvedValue(pedido());
    anonymizeContato.mockResolvedValue({ clienteDaBase: "c7" });
    const r = await request(app).post("/titular/pedidos/p1/eliminar-contato").set("x-role", "ADMIN").send({ telefone: "84999998888", confirmacao: "ELIMINAR DADOS" });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "CONTATO_E_CLIENTE", clientId: "c7" });
    expect(db.pedidoTitular.update).not.toHaveBeenCalled();
    db.pedidoTitular.findFirst.mockResolvedValue(pedido({ clientId: "c1" }));
    expect((await request(app).post("/titular/pedidos/p1/eliminar-contato").set("x-role", "ADMIN").send({ telefone: "84999998888", confirmacao: "ELIMINAR DADOS" })).status).toBe(409);
    db.pedidoTitular.findFirst.mockResolvedValue(pedido({ tipo: "ACESSO" }));
    expect((await request(app).post("/titular/pedidos/p1/eliminar-contato").set("x-role", "ADMIN").send({ telefone: "84999998888", confirmacao: "ELIMINAR DADOS" })).status).toBe(409);
  });

  it("relatorio-contato: telefone no corpo, só ADMIN, auditado só com contagens", async () => {
    db.pedidoTitular.findFirst.mockResolvedValue(pedido({ tipo: "ACESSO" }));
    relatorioContato.mockResolvedValue({ listasManuais: [{}], mensagens: [{}, {}], conversas: [] });
    expect((await request(app).post("/titular/pedidos/p1/relatorio-contato").send({ telefone: "84977776666" })).status).toBe(403);
    const r = await request(app).post("/titular/pedidos/p1/relatorio-contato").set("x-role", "ADMIN").send({ telefone: "84977776666" });
    expect(r.status).toBe(200);
    expect(relatorioContato.mock.calls[0].slice(1)).toEqual(["t1", "84977776666"]);
    expect(audit.mock.calls.at(-1)[0]).toMatchObject({ action: "RELATORIO_CONTATO", targetId: "p1", details: { listas: 1, mensagens: 2, conversas: 0 } });
    expect(JSON.stringify(audit.mock.calls.at(-1)[0])).not.toContain("7777");
  });
});


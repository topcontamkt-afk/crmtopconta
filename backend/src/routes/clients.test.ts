import express from "express";
import request from "supertest";

const db = {
  client: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  pedidoTitular: { findFirst: jest.fn(), update: jest.fn() },
  tenant: { findUnique: jest.fn(async () => ({ cpfSalt: "salt-teste" })) },
  supressaoTitular: { deleteMany: jest.fn(async (..._a: any[]) => ({ count: 1 })), findMany: jest.fn(async (..._a: any[]) => []), createMany: jest.fn(async (..._a: any[]) => ({ count: 0 })) },
  movement: { count: jest.fn(async () => 0) },
  messageEvent: { count: jest.fn(async () => 0) },
  purchase: { count: jest.fn(async () => 0) },
  accountSnapshot: { count: jest.fn(async () => 0) },
  conversation: { count: jest.fn(async () => 0) },
  segmentDefinition: { updateMany: jest.fn(async () => ({ count: 0 })) },
  rawExecute: jest.fn(async (..._a: any[]) => 0),
};
jest.mock("../config/db", () => ({ prisma: db, tenantRaw: { execute: (...a: any[]) => db.rawExecute(...a) } }));
const mockAnonymize = jest.fn();
const mockRedigir = jest.fn();
jest.mock("../services/retention", () => ({
  anonymizeClient: (...a: any[]) => mockAnonymize(...a),
  redigirAuditoria: (...a: any[]) => mockRedigir(...a),
}));
const mockEstaSuprimido = jest.fn();
const mockOptOutTel = jest.fn();
jest.mock("../services/privacy", () => ({
  ...jest.requireActual("../services/privacy"),
  estaSuprimido: (...a: any[]) => mockEstaSuprimido(...a),
  registrarOptOutTelefone: (...a: any[]) => mockOptOutTel(...a),
}));
const mockLiberar = jest.fn();
jest.mock("../services/dedupe", () => ({ liberarEliminacao: (...a: any[]) => mockLiberar(...a) }));
jest.mock("../middleware/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: "u1", tenantId: "t1", role: (req.headers["x-role"] as string) || "OPERATOR" };
    next();
  },
  requireRole: (...roles: string[]) => (req: any, res: any, next: any) => (roles.includes(req.user.role) ? next() : res.status(403).json({ error: "Sem permissão" })),
}));
jest.mock("../middleware/audit", () => ({ logAudit: jest.fn(async () => undefined) }));
const relatorio = jest.fn();
jest.mock("../services/titular", () => ({ relatorioTitular: (...a: any[]) => relatorio(...a) }));

import router from "./clients";
import { logAudit } from "../middleware/audit";

const app = express();
app.use(express.json());
app.use("/clients", router);

const audit = logAudit as jest.Mock;
const TEL = "+5584999998888";
const linha = (i: number) => ({ id: `c${i}`, nome: `Cliente ${i}`, telefone: TEL, cidade: "Natal", percentualUtilizado: 10, faixaUso: "BAIXO", statusConta: "ATIVO", autorizacaoComunicacao: true, bloqueadoLgpdAt: null });

beforeEach(() => {
  jest.clearAllMocks();
  db.client.findMany.mockResolvedValue([linha(1)]);
  db.client.count.mockResolvedValue(1);
  mockEstaSuprimido.mockResolvedValue(null);
  mockOptOutTel.mockResolvedValue({ clientIds: [], telefoneMasked: null });
  mockLiberar.mockResolvedValue(1);
  mockRedigir.mockResolvedValue(0);
});

describe("LGPD 01-04: listagem mínima, mascarada para VIEWER e com trilha em volume", () => {
  it("usa select explícito, sem cpfHash, renda nem nascimento", async () => {
    await request(app).get("/clients");
    const arg = db.client.findMany.mock.calls[0][0];
    expect(arg.select).toBeDefined();
    for (const campo of ["cpfHash", "remuneracaoBruta", "remuneracaoLiquida", "dataNascimento", "email"]) expect(arg.select[campo]).toBeUndefined();
  });

  it("VIEWER recebe o telefone mascarado; OPERATOR recebe completo", async () => {
    const v = await request(app).get("/clients").set("x-role", "VIEWER");
    expect(v.body.items[0].telefone).toBe("*********8888");
    expect(v.body.items[0].telefoneMascarado).toBe(true);
    const o = await request(app).get("/clients");
    expect(o.body.items[0].telefone).toBe(TEL);
  });

  it("página pequena não audita; leitura que passa do limiar grava escopo e quantidade, sem dados", async () => {
    await request(app).get("/clients?pageSize=25");
    expect(audit).not.toHaveBeenCalled();

    db.client.findMany.mockResolvedValue(Array.from({ length: 100 }, (_, i) => linha(i)));
    db.client.count.mockResolvedValue(3500);
    await request(app).get("/clients?pageSize=100&cidade=Natal");
    expect(audit).toHaveBeenCalledTimes(1);
    const d = audit.mock.calls[0][0];
    expect(d.action).toBe("READ_CLIENTS_BULK");
    expect(d.details).toMatchObject({ quantidade: 100, total: 3500, filtros: { cidade: ["Natal"], busca: false } });
    expect(JSON.stringify(d)).not.toContain("8888");
  });

  it("detalhe: select sem cpfHash/renda e telefone mascarado para VIEWER", async () => {
    db.client.findFirst.mockResolvedValue({ ...linha(1), email: "a@b.com", cpfMasked: "***.***.***-25", movements: [], messageEvents: [] });
    const r = await request(app).get("/clients/c1").set("x-role", "VIEWER");
    expect(r.body.telefone).toBe("*********8888");
    expect(r.body.email).toBeUndefined();
    const sel = db.client.findFirst.mock.calls[0][0].select;
    expect(sel.cpfHash).toBeUndefined();
    expect(sel.remuneracaoBruta).toBeUndefined();
    expect(sel.dataNascimento).toBeUndefined();
  });
});

describe("LGPD 03-04: bloqueio", () => {
  it("listagem padrão exclui bloqueados; filtro explícito mostra só eles", async () => {
    await request(app).get("/clients");
    expect(JSON.stringify(db.client.findMany.mock.calls[0][0].where)).toContain('"bloqueadoLgpdAt":null');
    await request(app).get("/clients?bloqueados=somente");
    expect(db.client.findMany.mock.calls[1][0].where.AND[1]).toEqual({ bloqueadoLgpdAt: { not: null } });
  });

  it("POST/DELETE /:id/bloqueio: só ADMIN, grava a data e audita", async () => {
    db.client.findFirst.mockResolvedValue({ id: "c1", bloqueadoLgpdAt: null });
    expect((await request(app).post("/clients/c1/bloqueio")).status).toBe(403);
    const r = await request(app).post("/clients/c1/bloqueio").set("x-role", "ADMIN");
    expect(r.status).toBe(200);
    expect(db.client.update.mock.calls[0][0].data.bloqueadoLgpdAt).toBeInstanceOf(Date);
    expect(audit.mock.calls[0][0]).toMatchObject({ action: "BLOQUEIO_LGPD", targetId: "c1" });

    db.client.findFirst.mockResolvedValue({ id: "c1", bloqueadoLgpdAt: new Date() });
    const d = await request(app).delete("/clients/c1/bloqueio").set("x-role", "ADMIN");
    expect(d.status).toBe(200);
    expect(db.client.update.mock.calls[1][0].data).toEqual({ bloqueadoLgpdAt: null });
    expect(audit.mock.calls[1][0].action).toBe("DESBLOQUEIO_LGPD");
  });
});

describe("LGPD 05-01: export", () => {
  it("sai mascarado por padrão, sem bloqueados, e audita filtros e quantidade", async () => {
    const r = await request(app).get("/clients/export.csv?cidade=Natal").set("x-role", "ANALYST");
    expect(r.status).toBe(200);
    expect(r.text).toContain("*********8888");
    expect(r.text).not.toContain(TEL);
    expect(JSON.stringify(db.client.findMany.mock.calls[0][0].where)).toContain('"bloqueadoLgpdAt":null');
    expect(audit.mock.calls[0][0]).toMatchObject({ action: "EXPORT_CLIENTS", details: { count: 1, telefoneCompleto: false, filtros: { cidade: ["Natal"] } } });
  });

  it("telefone completo: só ADMIN e com motivo, que vai para o AuditLog", async () => {
    expect((await request(app).post("/clients/export.csv").send({ completo: true, motivo: "incidente" }).set("x-role", "OPERATOR")).status).toBe(403);
    expect((await request(app).post("/clients/export.csv").send({ completo: true }).set("x-role", "ADMIN")).status).toBe(400);
    const r = await request(app).post("/clients/export.csv").send({ completo: true, motivo: "resposta a incidente" }).set("x-role", "ADMIN");
    expect(r.status).toBe(200);
    expect(r.text).toContain(TEL);
    expect(audit.mock.calls[0][0].details).toMatchObject({ telefoneCompleto: true, motivo: "resposta a incidente" });
  });

  it("motivo nunca vai na URL: GET com completo/motivo é recusado (LGPD 07-03)", async () => {
    const r = await request(app).get("/clients/export.csv?completo=1&motivo=resposta%20a%20incidente").set("x-role", "ADMIN");
    expect(r.status).toBe(400);
    expect(db.client.findMany).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("mantém o escape anti-fórmula", async () => {
    db.client.findMany.mockResolvedValue([{ ...linha(1), nome: "=HYPERLINK(1)", cpfMasked: "x" }]);
    const r = await request(app).get("/clients/export.csv").set("x-role", "ADMIN");
    expect(r.text).toContain("'=HYPERLINK(1)");
  });
});

describe("LGPD 07-03: busca fora da URL", () => {
  it("GET com ?search= é recusado com 400 e mensagem clara", async () => {
    const r = await request(app).get("/clients?search=Maria");
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/POST \/api\/clients\/search/);
    expect((await request(app).get("/clients/export.csv?search=Maria").set("x-role", "ADMIN")).status).toBe(400);
    expect(db.client.findMany).not.toHaveBeenCalled();
  });

  it("POST /search leva o termo no corpo e não o grava no AuditLog", async () => {
    db.client.findMany.mockResolvedValue(Array.from({ length: 60 }, (_, i) => linha(i)));
    const r = await request(app).post("/clients/search").send({ search: "Maria", pageSize: 60, statusConta: ["ATIVO"] });
    expect(r.status).toBe(200);
    expect(JSON.stringify(db.client.findMany.mock.calls[0][0].where)).toContain("Maria");
    expect(audit.mock.calls[0][0].details.filtros).toEqual({ statusConta: ["ATIVO"], busca: true });
    expect(JSON.stringify(audit.mock.calls[0][0])).not.toContain("Maria");
  });

  it("POST /export.csv aceita busca e motivo no corpo", async () => {
    const r = await request(app).post("/clients/export.csv").set("x-role", "ADMIN").send({ search: "Maria", completo: true, motivo: "pedido do titular" });
    expect(r.status).toBe(200);
    expect(r.text).toContain(TEL);
  });
});

describe("LGPD 03-03: correção de telefone e e-mail", () => {
  const existente = { id: "c1", tenantId: "t1", nome: "Maria", cidade: "Natal", telefone: "+5584988887777", email: null, autorizacaoComunicacao: true, camposCorrigidos: { nome: "2026-01-01T00:00:00.000Z" } };

  it("normaliza o telefone, grava a trava de cada campo que mudou e audita sem valores", async () => {
    db.client.findFirst.mockResolvedValue(existente);
    db.client.update.mockResolvedValue({ id: "c1" });
    const r = await request(app).patch("/clients/c1").send({ telefone: "(84) 99999-8888", email: "Maria@Exemplo.com", cidade: "Natal" });
    expect(r.status).toBe(200);
    const data = db.client.update.mock.calls[0][0].data;
    expect(data.telefone).toBe(TEL);
    expect(data.email).toBe("maria@exemplo.com");
    // cidade veio igual: não trava; nome antigo continua travado
    expect(Object.keys(data.camposCorrigidos).sort()).toEqual(["email", "nome", "telefone"]);
    expect(data.camposCorrigidos.nome).toBe("2026-01-01T00:00:00.000Z");
    const a = audit.mock.calls[0][0];
    expect(a.details.camposCorrigidos).toEqual(["telefone", "email"]);
    expect(JSON.stringify(a)).not.toMatch(/8888|exemplo/i);
    // resposta também com select explícito
    expect(db.client.update.mock.calls[0][0].select.cpfHash).toBeUndefined();
  });

  it("telefone ou e-mail inválidos: 400 e nada gravado", async () => {
    db.client.findFirst.mockResolvedValue(existente);
    expect((await request(app).patch("/clients/c1").send({ telefone: "123" })).status).toBe(400);
    expect((await request(app).patch("/clients/c1").send({ email: "nao-e-email" })).status).toBe(400);
    expect(db.client.update).not.toHaveBeenCalled();
  });
});

describe("LGPD 03-02: relatório do titular", () => {
  it("só ADMIN; download JSON auditado só com contagens", async () => {
    expect((await request(app).get("/clients/c1/relatorio-titular")).status).toBe(403);
    relatorio.mockResolvedValue({
      titular: { nome: "Maria" },
      movimentacoes: [1],
      historicoConta: [],
      compras: [1, 2],
      mensagens: [],
      conversas: [],
      listasManuais: [],
      pedidos: [],
      compartilhamento: { suboperadores: [{ nome: "Z-API" }], infraestrutura: [] },
    });
    const r = await request(app).get("/clients/c1/relatorio-titular").set("x-role", "ADMIN");
    expect(r.status).toBe(200);
    expect(r.headers["content-disposition"]).toMatch(/attachment; filename="titular-/);
    expect(relatorio).toHaveBeenCalledWith(db, "t1", "c1");
    const a = audit.mock.calls[0][0];
    expect(a).toMatchObject({ action: "RELATORIO_TITULAR", targetId: "c1", details: { compras: 2, suboperadores: ["Z-API"] } });
    expect(JSON.stringify(a)).not.toContain("Maria");
  });

  it("cliente de outro tenant/inexistente: 404", async () => {
    relatorio.mockResolvedValue(null);
    expect((await request(app).get("/clients/x/relatorio-titular").set("x-role", "ADMIN")).status).toBe(404);
  });
});

describe("LGPD 03-01 / 04-01: eliminar dados do titular", () => {
  const corpo = { motivo: "Pedido do titular por e-mail", confirmacao: "ELIMINAR DADOS" };
  const PEDIDO = "11111111-1111-4111-8111-111111111111";

  it("só ADMIN, com motivo e frase de confirmação", async () => {
    db.client.findFirst.mockResolvedValue({ id: "c1", anonymizedAt: null });
    expect((await request(app).post("/clients/c1/anonymize").send(corpo)).status).toBe(403);
    expect((await request(app).post("/clients/c1/anonymize").set("x-role", "ADMIN").send({ motivo: "Pedido do titular" })).status).toBe(400);
    expect((await request(app).post("/clients/c1/anonymize").set("x-role", "ADMIN").send({ ...corpo, motivo: "x" })).status).toBe(400);
    expect(mockAnonymize).not.toHaveBeenCalled();
  });

  it("anonimiza com origem PEDIDO_TITULAR e devolve o aviso da cópia externa; pedido aberto fica atendido", async () => {
    db.client.findFirst.mockResolvedValue({ id: "c1", anonymizedAt: null });
    db.pedidoTitular.findFirst.mockResolvedValue({ id: PEDIDO, tipo: "ELIMINACAO", status: "ABERTO" });
    mockAnonymize.mockResolvedValue({ clientId: "c1", copiasExternas: [{ provedor: "Z-API", apagarManualmente: true }] });
    const r = await request(app).post("/clients/c1/anonymize").set("x-role", "ADMIN").send({ ...corpo, pedidoId: PEDIDO });
    expect(r.status).toBe(200);
    expect(r.body.copiasExternas[0].apagarManualmente).toBe(true);
    expect(mockAnonymize).toHaveBeenCalledWith(db, "t1", "c1", expect.objectContaining({ origem: "PEDIDO_TITULAR", userId: "u1", motivo: corpo.motivo, pedidoId: PEDIDO }));
    expect(db.pedidoTitular.findFirst.mock.calls[0][0].where).toMatchObject({ tenantId: "t1" });
    expect(db.pedidoTitular.update.mock.calls[0][0].data.status).toBe("ATENDIDO");
  });

  it("já anonimizado: 409; inexistente: 404; pedido de outro tenant: 404", async () => {
    db.client.findFirst.mockResolvedValue({ id: "c1", anonymizedAt: new Date() });
    expect((await request(app).post("/clients/c1/anonymize").set("x-role", "ADMIN").send(corpo)).status).toBe(409);
    db.client.findFirst.mockResolvedValue(null);
    expect((await request(app).post("/clients/c1/anonymize").set("x-role", "ADMIN").send(corpo)).status).toBe(404);
    db.client.findFirst.mockResolvedValue({ id: "c1", anonymizedAt: null });
    db.pedidoTitular.findFirst.mockResolvedValue(null);
    expect((await request(app).post("/clients/c1/anonymize").set("x-role", "ADMIN").send({ ...corpo, pedidoId: PEDIDO })).status).toBe(404);
    expect(mockAnonymize).not.toHaveBeenCalled();
  });
});

describe("LGPD 03-01: liberação manual da supressão por eliminação", () => {
  const CPF = "529.982.247-25";

  it("calcula o hash no servidor e nunca passa o CPF adiante", async () => {
    expect((await request(app).post("/clients/supressao/liberar").send({ cpf: CPF, motivo: "voltou a ser cliente" })).status).toBe(403);
    expect((await request(app).post("/clients/supressao/liberar").set("x-role", "ADMIN").send({ cpf: "123", motivo: "voltou a ser cliente" })).status).toBe(400);
    const r = await request(app).post("/clients/supressao/liberar").set("x-role", "ADMIN").send({ cpf: CPF, motivo: "voltou a ser cliente" });
    expect(r.status).toBe(200);
    const [, tenantId, docHash, opts] = mockLiberar.mock.calls[0];
    expect(tenantId).toBe("t1");
    expect(docHash).toMatch(/^[0-9a-f]{64}$/);
    expect(opts).toMatchObject({ motivo: "voltou a ser cliente", origem: "manual", userId: "u1" });
    expect(JSON.stringify(mockLiberar.mock.calls)).not.toContain("52998224725");
    expect(JSON.stringify(audit.mock.calls)).not.toContain("52998224725");
  });

  it("nada a liberar: 404", async () => {
    mockLiberar.mockResolvedValueOnce(0);
    expect((await request(app).post("/clients/supressao/liberar").set("x-role", "ADMIN").send({ cpf: CPF, motivo: "voltou a ser cliente" })).status).toBe(404);
  });
});

describe("LGPD 02-02 / 02-03: opt-out manual e reautorização", () => {
  const base = { id: "c1", tenantId: "t1", nome: "Maria", telefone: TEL, cpfHash: "h1", autorizacaoComunicacao: true, optOutAt: null, bloqueadoLgpdAt: null, anonymizedAt: null, camposCorrigidos: {} };

  it("tirar a autorização registra o opt-out do TELEFONE (canal MANUAL)", async () => {
    db.client.findFirst.mockResolvedValue(base);
    db.client.update.mockResolvedValue({ id: "c1" });
    const r = await request(app).patch("/clients/c1").send({ autorizacaoComunicacao: false });
    expect(r.status).toBe(200);
    expect(mockOptOutTel).toHaveBeenCalledWith(db, "t1", expect.objectContaining({ telefone: TEL, canal: "MANUAL" }));
    expect(db.client.update.mock.calls[0][0].data.optOutAt).toBeInstanceOf(Date);
  });

  it("religar quem tem opt-out: OPERATOR 403, ADMIN sem motivo 400, com motivo remove a supressão e audita", async () => {
    const optado = { ...base, autorizacaoComunicacao: false, optOutAt: new Date("2026-09-01T00:00:00Z") };
    db.client.findFirst.mockResolvedValue(optado);
    db.client.update.mockResolvedValue({ id: "c1" });
    expect((await request(app).patch("/clients/c1").send({ autorizacaoComunicacao: true })).status).toBe(403);
    expect((await request(app).patch("/clients/c1").set("x-role", "ADMIN").send({ autorizacaoComunicacao: true })).status).toBe(400);
    expect(db.client.update).not.toHaveBeenCalled();
    const r = await request(app).patch("/clients/c1").set("x-role", "ADMIN").send({ autorizacaoComunicacao: true, motivoReautorizacao: "Novo consentimento assinado" });
    expect(r.status).toBe(200);
    const data = db.client.update.mock.calls[0][0].data;
    expect(data.optOutAt).toBeNull();
    expect(data.motivoReautorizacao).toBeUndefined();
    expect(db.supressaoTitular.deleteMany.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", motivo: "OPT_OUT" });
    const a = audit.mock.calls.find((c: any[]) => c[0].action === "REAUTORIZACAO_COMUNICACAO")![0];
    expect(a.details.motivo).toBe("Novo consentimento assinado");
  });

  it("opt-out só pela supressão do telefone também exige ADMIN", async () => {
    db.client.findFirst.mockResolvedValue({ ...base, autorizacaoComunicacao: false });
    mockEstaSuprimido.mockResolvedValueOnce("OPT_OUT");
    expect((await request(app).patch("/clients/c1").send({ autorizacaoComunicacao: true })).status).toBe(403);
  });

  it("eliminação/bloqueio: nunca religa (409)", async () => {
    db.client.findFirst.mockResolvedValue({ ...base, autorizacaoComunicacao: false });
    mockEstaSuprimido.mockResolvedValueOnce("ELIMINACAO");
    expect((await request(app).patch("/clients/c1").set("x-role", "ADMIN").send({ autorizacaoComunicacao: true, motivoReautorizacao: "qualquer motivo" })).status).toBe(409);
    db.client.findFirst.mockResolvedValue({ ...base, autorizacaoComunicacao: false, bloqueadoLgpdAt: new Date() });
    expect((await request(app).patch("/clients/c1").set("x-role", "ADMIN").send({ autorizacaoComunicacao: true, motivoReautorizacao: "qualquer motivo" })).status).toBe(409);
    expect(db.client.update).not.toHaveBeenCalled();
  });
});

describe("LGPD 04-05: limpar base", () => {
  it("preserva opt-out como supressão, apaga tudo num bloco só (ordem das FKs) e redige a auditoria", async () => {
    db.client.findMany.mockImplementation(async ({ where }: any) =>
      where.OR ? [{ telefone: TEL, cpfHash: "h1", optOutAt: new Date(), bloqueadoLgpdAt: null }] : [{ id: "c1" }, { id: "c2" }]
    );
    mockRedigir.mockResolvedValue(3);
    expect((await request(app).post("/clients/purge").set("x-role", "ADMIN").send({ confirm: "errado" })).status).toBe(400);
    const r = await request(app).post("/clients/purge").set("x-role", "ADMIN").send({ confirm: "LIMPAR BASE" });
    expect(r.status).toBe(200);
    expect(db.supressaoTitular.createMany.mock.calls[0][0].data[0]).toMatchObject({ tenantId: "t1", motivo: "OPT_OUT", docHash: "h1" });
    expect(db.rawExecute).toHaveBeenCalledTimes(1);
    const sql: string = db.rawExecute.mock.calls[0][0];
    const ordem = ['"WaMediaBlob"', '"WaMessage"', 'DELETE FROM "Conversation"', '"CampaignRecipient"', '"MessageEvent"', '"Movement"', '"AccountSnapshot"', '"Purchase"', '"ImportChange"', 'DELETE FROM "Client"'];
    const pos = ordem.map((t) => sql.indexOf(t));
    expect(pos.every((p) => p >= 0)).toBe(true);
    expect([...pos].sort((x, y) => x - y)).toEqual(pos);
    expect(sql).toContain("current_setting('app.tenant_id')");
    expect(mockRedigir).toHaveBeenCalledWith(db, "t1", ["c1", "c2"], "LIMPAR_BASE");
    expect(audit.mock.calls[0][0]).toMatchObject({ action: "PURGE_CLIENTS", details: { clients: 2, supressoesGravadas: 1, auditoriaRedigida: 3 } });
  });
});

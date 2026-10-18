import express from "express";
import request from "supertest";

const db = {
  client: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  pedidoTitular: { findFirst: jest.fn() },
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
    expect((await request(app).get("/clients/export.csv?completo=1&motivo=incidente").set("x-role", "OPERATOR")).status).toBe(403);
    expect((await request(app).get("/clients/export.csv?completo=1").set("x-role", "ADMIN")).status).toBe(400);
    const r = await request(app).get("/clients/export.csv?completo=1&motivo=resposta%20a%20incidente").set("x-role", "ADMIN");
    expect(r.status).toBe(200);
    expect(r.text).toContain(TEL);
    expect(audit.mock.calls[0][0].details).toMatchObject({ telefoneCompleto: true, motivo: "resposta a incidente" });
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

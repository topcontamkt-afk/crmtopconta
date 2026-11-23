jest.mock("../config/db", () => ({ prisma: { auditLog: { count: jest.fn() }, user: { findFirst: jest.fn().mockResolvedValue({ role: "ADMIN", areasRestritas: false, areas: [] }) }, tenant: { findUnique: jest.fn(), update: jest.fn() } }, tenantRaw: { query: jest.fn() } }));
let papel = "ADMIN";
jest.mock("../middleware/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: "u1", tenantId: "t1", role: papel, email: "a@b.c" };
    next();
  },
  requireRole: (...papeis: string[]) => (req: any, res: any, next: any) => (papeis.includes(req.user.role) ? next() : res.status(403).json({ error: "Permissão insuficiente para esta ação" })),
}));
jest.mock("../middleware/audit", () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../services/assistente/assistente", () => ({ responder: jest.fn() }));
jest.mock("../services/assistente/ferramentas", () => ({ NOMES_FERRAMENTAS: ["resumo_base"] }));
jest.mock("../services/assistente/provedores/modelos", () => {
  const real = jest.requireActual("../services/assistente/provedores/modelos");
  return { ...real, listarModelos: jest.fn() };
});

import express from "express";
import request from "supertest";
import { prisma } from "../config/db";
import { logAudit } from "../middleware/audit";
import { responder } from "../services/assistente/assistente";
import { listarModelos } from "../services/assistente/provedores/modelos";
import { ErroProvedor } from "../services/assistente/provedores/tipos";
import router, { _definirFabricaDeProvedor } from "./assistente";

const app = express();
app.use(express.json());
app.use("/api/assistente", router);

const pergunta = { mensagens: [{ role: "user", content: "Quantos clientes temos?" }] };
const resposta = { resposta: "Há 100 clientes.", ferramentas: [{ nome: "resumo_base", entrada: {}, ok: true }], uso: { entrada: 10, saida: 5, cacheLeitura: 0 }, provedor: "anthropic", modelo: "claude-opus-5-5", fim: "completo", avisos: [] };
const find = prisma.tenant.findUnique as jest.Mock;
const fabrica = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  papel = "ADMIN";
  process.env.ANTHROPIC_API_KEY = "sk-ant-teste";
  process.env.OPENAI_API_KEY = "sk-openai-teste";
  delete process.env.ASSISTENTE_LIMITE_DIARIO;
  delete process.env.ASSISTENTE_PROVEDOR;
  delete process.env.ASSISTENTE_MODELO;
  (prisma.auditLog.count as jest.Mock).mockResolvedValue(0);
  find.mockResolvedValue({ assistente: null });
  (responder as jest.Mock).mockResolvedValue(resposta);
  fabrica.mockReturnValue({ nome: "anthropic", responder: jest.fn() });
  _definirFabricaDeProvedor(fabrica);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("GET /status", () => {
  it("mostra provedor, modelo, se a chave do provedor escolhido existe e a cota usada", async () => {
    (prisma.auditLog.count as jest.Mock).mockResolvedValue(7);
    const r = await request(app).get("/api/assistente/status");
    expect(r.body).toMatchObject({ configurado: true, provedor: "anthropic", modelo: "claude-opus-5-5", limiteDiario: 50, usadasHoje: 7 });
  });
  it("a chave que importa é a do provedor escolhido na conta", async () => {
    find.mockResolvedValue({ assistente: { provedor: "openai", modelo: "gpt-4.1" } });
    delete process.env.OPENAI_API_KEY;
    const r = await request(app).get("/api/assistente/status");
    expect(r.body).toMatchObject({ provedor: "openai", modelo: "gpt-4.1", configurado: false });
  });
});

describe("GET/PUT /config e GET /modelos (só ADMIN)", () => {
  it("config mostra a escolha e, por provedor, só SE a chave existe (nunca a chave)", async () => {
    delete process.env.OPENAI_API_KEY;
    const r = await request(app).get("/api/assistente/config");
    expect(r.status).toBe(200);
    const por = Object.fromEntries(r.body.provedores.map((p: any) => [p.nome, p.chaveConfigurada]));
    expect(por).toEqual({ anthropic: true, openai: false });
    expect(JSON.stringify(r.body)).not.toMatch(/sk-ant|sk-openai/);
  });

  it("quem não é ADMIN não vê nem altera a configuração nem lista modelos", async () => {
    papel = "OPERATOR";
    expect((await request(app).get("/api/assistente/config")).status).toBe(403);
    expect((await request(app).get("/api/assistente/modelos?provedor=openai")).status).toBe(403);
    expect((await request(app).put("/api/assistente/config").send({ provedor: "openai", modelo: "gpt-4.1" })).status).toBe(403);
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it("lista os modelos do provedor pedido; provedor inválido é 400", async () => {
    (listarModelos as jest.Mock).mockResolvedValue({ modelos: ["gpt-4.1"], fonte: "api" });
    const r = await request(app).get("/api/assistente/modelos?provedor=openai");
    expect(r.body).toEqual({ modelos: ["gpt-4.1"], fonte: "api" });
    expect(listarModelos).toHaveBeenCalledWith("openai");
    expect((await request(app).get("/api/assistente/modelos?provedor=google")).status).toBe(400);
  });

  it("salva provedor e modelo na conta e audita", async () => {
    const r = await request(app).put("/api/assistente/config").send({ provedor: "openai", modelo: "gpt-4.1-mini" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ provedor: "openai", modelo: "gpt-4.1-mini", origem: "conta", chaveConfigurada: true });
    expect(prisma.tenant.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { assistente: { provedor: "openai", modelo: "gpt-4.1-mini" } } });
    expect((logAudit as jest.Mock).mock.calls[0][0]).toMatchObject({ tenantId: "t1", userId: "u1", details: { assistente: { provedor: "openai", modelo: "gpt-4.1-mini" } } });
  });

  it.each([
    ["provedor desconhecido", { provedor: "google", modelo: "x" }],
    ["modelo com espaço", { provedor: "openai", modelo: "gpt 4" }],
    ["tentativa de mandar a chave", { provedor: "openai", modelo: "gpt-4.1", chave: "sk-x" }],
  ])("recusa configuração inválida (%s)", async (_n, corpo) => {
    expect((await request(app).put("/api/assistente/config").send(corpo)).status).toBe(400);
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it("coluna ainda não criada: 503 SEM_COLUNA com instrução", async () => {
    (prisma.tenant.update as jest.Mock).mockRejectedValue(new Error("column assistente does not exist"));
    const r = await request(app).put("/api/assistente/config").send({ provedor: "openai", modelo: "gpt-4.1" });
    expect(r.status).toBe(503);
    expect(r.body.codigo).toBe("SEM_COLUNA");
  });
});

describe("POST /", () => {
  it("sem a chave do provedor escolhido: 503 NAO_CONFIGURADO citando o provedor, sem consultar nada", async () => {
    find.mockResolvedValue({ assistente: { provedor: "openai", modelo: "gpt-4.1" } });
    delete process.env.OPENAI_API_KEY;
    const r = await request(app).post("/api/assistente").send(pergunta);
    expect(r.status).toBe(503);
    expect(r.body.codigo).toBe("NAO_CONFIGURADO");
    expect(r.body.error).toMatch(/GPT/);
    expect(responder).not.toHaveBeenCalled();
  });

  it.each([
    ["sem mensagens", { mensagens: [] }],
    ["começa pelo assistente", { mensagens: [{ role: "assistant", content: "oi" }, { role: "user", content: "x" }] }],
    ["termina pelo assistente", { mensagens: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }] }],
    ["texto enorme", { mensagens: [{ role: "user", content: "x".repeat(4001) }] }],
    ["campo extra (tentativa de passar o tenant ou o modelo)", { mensagens: [{ role: "user", content: "x" }], tenantId: "outro", modelo: "gpt-x" }],
    ["papel inválido", { mensagens: [{ role: "system", content: "x" }] }],
  ])("entrada inválida (%s): 400", async (_n, corpo) => {
    const r = await request(app).post("/api/assistente").send(corpo);
    expect(r.status).toBe(400);
    expect(responder).not.toHaveBeenCalled();
  });

  it("usa o provedor e o modelo ESCOLHIDOS na conta, com a chave do servidor, e o tenant do login", async () => {
    find.mockResolvedValue({ assistente: { provedor: "openai", modelo: "gpt-4.1-mini" } });
    const r = await request(app).post("/api/assistente").send(pergunta);
    expect(r.status).toBe(200);
    expect(fabrica).toHaveBeenCalledWith("openai", "sk-openai-teste");
    const arg = (responder as jest.Mock).mock.calls[0][0];
    expect(arg.modelo).toBe("gpt-4.1-mini");
    expect(arg.ctx).toMatchObject({ tenantId: "t1", userId: "u1", role: "ADMIN" });
    expect(typeof arg.ctx.podeUsar).toBe("function");
    expect(r.body).toMatchObject({ resposta: "Há 100 clientes.", restantesHoje: 49 });
  });

  it("sem escolha na conta vale o ambiente, depois Claude", async () => {
    await request(app).post("/api/assistente").send(pergunta);
    expect(fabrica).toHaveBeenCalledWith("anthropic", "sk-ant-teste");
    expect((responder as jest.Mock).mock.calls[0][0].modelo).toBe("claude-opus-5-5");
    process.env.ASSISTENTE_PROVEDOR = "openai";
    process.env.ASSISTENTE_MODELO = "gpt-4o";
    await request(app).post("/api/assistente").send(pergunta);
    expect(fabrica).toHaveBeenLastCalledWith("openai", "sk-openai-teste");
    expect((responder as jest.Mock).mock.calls[1][0].modelo).toBe("gpt-4o");
  });

  it("registra só metadados na auditoria (provedor, modelo, ferramentas, tokens), sem o texto da pergunta", async () => {
    await request(app).post("/api/assistente").send(pergunta);
    const audit = (logAudit as jest.Mock).mock.calls[0][0];
    expect(audit).toMatchObject({ tenantId: "t1", userId: "u1", action: "ASSISTENTE_PERGUNTA", details: { provedor: "anthropic", modelo: "claude-opus-5-5" } });
    expect(JSON.stringify(audit)).not.toContain("Quantos clientes");
  });

  it("limite diário por usuário: 429 sem consultar o modelo", async () => {
    process.env.ASSISTENTE_LIMITE_DIARIO = "3";
    (prisma.auditLog.count as jest.Mock).mockResolvedValue(3);
    const r = await request(app).post("/api/assistente").send(pergunta);
    expect(r.status).toBe(429);
    expect(r.body.codigo).toBe("LIMITE_DIARIO");
    expect(responder).not.toHaveBeenCalled();
  });

  it("falha ao gravar a auditoria não derruba a resposta", async () => {
    (logAudit as jest.Mock).mockRejectedValueOnce(new Error("banco fora"));
    expect((await request(app).post("/api/assistente").send(pergunta)).status).toBe(200);
  });

  it.each([
    ["CHAVE_RECUSADA", 503],
    ["LIMITE_PROVEDOR", 429],
    ["TEMPO_ESGOTADO", 504],
    ["MODELO_INVALIDO", 400],
    ["FALHA_PROVEDOR", 502],
  ])("erro %s do provedor vira %s com mensagem neutra, sem vazar detalhes", async (codigo, status) => {
    (responder as jest.Mock).mockRejectedValue(new ErroProvedor(codigo as any, "detalhe interno sk-ant-segredo", 500));
    const r = await request(app).post("/api/assistente").send(pergunta);
    expect(r.status).toBe(status);
    expect(r.body.codigo).toBe(codigo);
    expect(JSON.stringify(r.body)).not.toMatch(/sk-ant|segredo|detalhe interno/);
  });

  it("erro inesperado vira 502", async () => {
    (responder as jest.Mock).mockRejectedValue(new Error("boom com detalhes internos"));
    const r = await request(app).post("/api/assistente").send(pergunta);
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.body)).not.toMatch(/boom/);
  });
});

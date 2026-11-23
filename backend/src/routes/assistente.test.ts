jest.mock("../config/db", () => ({ prisma: { auditLog: { count: jest.fn() }, user: { findFirst: jest.fn().mockResolvedValue({ role: "ADMIN", areasRestritas: false, areas: [] }) } }, tenantRaw: { query: jest.fn() } }));
jest.mock("../middleware/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: "u1", tenantId: "t1", role: "ADMIN", email: "a@b.c" };
    next();
  },
}));
jest.mock("../middleware/audit", () => ({ logAudit: jest.fn() }));
jest.mock("../services/assistente/assistente", () => ({ MODELO_PADRAO: "claude-opus-5-5", responder: jest.fn() }));
jest.mock("../services/assistente/ferramentas", () => ({ NOMES_FERRAMENTAS: ["resumo_base"] }));

import express from "express";
import request from "supertest";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "../config/db";
import { logAudit } from "../middleware/audit";
import { responder } from "../services/assistente/assistente";
import router, { _definirFabricaDeCliente } from "./assistente";

const app = express();
app.use(express.json());
app.use("/api/assistente", router);

const pergunta = { mensagens: [{ role: "user", content: "Quantos clientes temos?" }] };
const resposta = { resposta: "Há 100 clientes.", ferramentas: [{ nome: "resumo_base", entrada: {}, ok: true }], uso: { entrada: 10, saida: 5, cacheLeitura: 0 }, modelo: "claude-opus-5-5", fim: "completo", avisos: [] };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ANTHROPIC_API_KEY = "sk-ant-teste";
  delete process.env.ASSISTENTE_LIMITE_DIARIO;
  delete process.env.ASSISTENTE_MODELO;
  (prisma.auditLog.count as jest.Mock).mockResolvedValue(0);
  (responder as jest.Mock).mockResolvedValue(resposta);
  _definirFabricaDeCliente(() => ({ beta: { messages: { create: jest.fn() } } }));
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("GET /status", () => {
  it("diz se está configurado e quanto da cota foi usado", async () => {
    (prisma.auditLog.count as jest.Mock).mockResolvedValue(7);
    const r = await request(app).get("/api/assistente/status");
    expect(r.body).toMatchObject({ configurado: true, modelo: "claude-opus-5-5", limiteDiario: 50, usadasHoje: 7 });
    delete process.env.ANTHROPIC_API_KEY;
    expect((await request(app).get("/api/assistente/status")).body.configurado).toBe(false);
  });
});

describe("POST /", () => {
  it("sem chave de IA: 503 NAO_CONFIGURADO e nada é consultado", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const r = await request(app).post("/api/assistente").send(pergunta);
    expect(r.status).toBe(503);
    expect(r.body.codigo).toBe("NAO_CONFIGURADO");
    expect(responder).not.toHaveBeenCalled();
  });

  it.each([
    ["sem mensagens", { mensagens: [] }],
    ["começa pelo assistente", { mensagens: [{ role: "assistant", content: "oi" }, { role: "user", content: "x" }] }],
    ["termina pelo assistente", { mensagens: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }] }],
    ["texto enorme", { mensagens: [{ role: "user", content: "x".repeat(4001) }] }],
    ["campo extra (tentativa de passar o tenant)", { mensagens: [{ role: "user", content: "x" }], tenantId: "outro" }],
    ["papel inválido", { mensagens: [{ role: "system", content: "x" }] }],
  ])("entrada inválida (%s): 400", async (_n, corpo) => {
    const r = await request(app).post("/api/assistente").send(corpo);
    expect(r.status).toBe(400);
    expect(responder).not.toHaveBeenCalled();
  });

  it("responde, usa o tenant do login e registra só metadados na auditoria", async () => {
    const r = await request(app).post("/api/assistente").send(pergunta);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ resposta: "Há 100 clientes.", fim: "completo", restantesHoje: 49 });
    const arg = (responder as jest.Mock).mock.calls[0][0];
    expect(arg.ctx).toMatchObject({ tenantId: "t1", userId: "u1", role: "ADMIN" });
    expect(arg.modelo).toBe("claude-opus-5-5");
    expect(typeof arg.ctx.podeUsar).toBe("function");
    const audit = (logAudit as jest.Mock).mock.calls[0][0];
    expect(audit).toMatchObject({ tenantId: "t1", userId: "u1", action: "ASSISTENTE_PERGUNTA" });
    expect(JSON.stringify(audit)).not.toContain("Quantos clientes");
    expect(audit.details.caracteresDaPergunta).toBe(pergunta.mensagens[0].content.length);
  });

  it("modelo configurável por variável de ambiente", async () => {
    process.env.ASSISTENTE_MODELO = "claude-sonnet-5-5";
    await request(app).post("/api/assistente").send(pergunta);
    expect((responder as jest.Mock).mock.calls[0][0].modelo).toBe("claude-sonnet-5-5");
  });

  it("limite diário por usuário: 429 sem consultar o modelo", async () => {
    process.env.ASSISTENTE_LIMITE_DIARIO = "3";
    (prisma.auditLog.count as jest.Mock).mockResolvedValue(3);
    const r = await request(app).post("/api/assistente").send(pergunta);
    expect(r.status).toBe(429);
    expect(r.body.codigo).toBe("LIMITE_DIARIO");
    expect(responder).not.toHaveBeenCalled();
    const filtro = (prisma.auditLog.count as jest.Mock).mock.calls[0][0].where;
    expect(filtro).toMatchObject({ tenantId: "t1", userId: "u1", action: "ASSISTENTE_PERGUNTA" });
  });

  it("falha ao gravar a auditoria não derruba a resposta", async () => {
    (logAudit as jest.Mock).mockRejectedValue(new Error("banco fora"));
    expect((await request(app).post("/api/assistente").send(pergunta)).status).toBe(200);
  });

  it.each([
    ["chave recusada", new Anthropic.AuthenticationError(401, { error: { message: "invalid x-api-key sk-ant-segredo" } } as any, "x", new Headers()), 503, "CHAVE_RECUSADA"],
    ["limite do provedor", new Anthropic.RateLimitError(429, { error: { message: "rate" } } as any, "x", new Headers()), 429, "LIMITE_PROVEDOR"],
    ["outro erro", new Error("boom com detalhes internos"), 502, "FALHA_PROVEDOR"],
  ])("erro do provedor (%s) vira mensagem neutra, sem vazar detalhes", async (_n, erro, status, codigo) => {
    (responder as jest.Mock).mockRejectedValue(erro);
    const r = await request(app).post("/api/assistente").send(pergunta);
    expect(r.status).toBe(status);
    expect(r.body.codigo).toBe(codigo);
    expect(JSON.stringify(r.body)).not.toMatch(/sk-ant|boom|segredo/);
  });
});

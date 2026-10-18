import express from "express";
import request from "supertest";

const importJobFindMany = jest.fn();
jest.mock("../config/db", () => ({ prisma: { importJob: { findMany: (...a: any[]) => importJobFindMany(...a), findFirst: jest.fn(async () => null) }, importChange: { count: jest.fn(async () => 0) }, client: { count: jest.fn(async () => 0) } } }));
jest.mock("../middleware/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: "u1", tenantId: "t1", role: (req.headers["x-role"] as string) || "OPERATOR" };
    next();
  },
  requireRole: (...roles: string[]) => (req: any, res: any, next: any) => (roles.includes(req.user.role) ? next() : res.status(403).json({ error: "Sem permissão" })),
}));
jest.mock("../middleware/rateLimit", () => ({ importLimiter: (_q: any, _r: any, n: any) => n() }));
jest.mock("../middleware/audit", () => ({
  logAudit: jest.fn(async () => undefined),
  logTentativaAcesso: jest.fn(async () => undefined),
  ACOES_ACESSO_INDEVIDO: { IMPORTACAO_PLANILHA_NEGADA: "IMPORT_GOOGLE_SHEETS_NEGADO" },
}));
jest.mock("../services/cardAccountImport", () => ({
  runCardAccountImport: jest.fn(async () => ({ importJobId: "j1", result: { totalRows: 1, addedCount: 0, updatedCount: 1, errorCount: 0, errors: [] } })),
  previewCardAccountImport: jest.fn(async () => ({ total: 1 })),
}));
jest.mock("../services/importService", () => ({ runImport: jest.fn() }));
jest.mock("../services/googleSheets", () => {
  class SheetAccessError extends Error {
    constructor(public status: number, public codigo: string, message: string) {
      super(message);
    }
  }
  return {
    DEFAULT_COLUMN_MAPPING: {},
    fetchSheetRows: jest.fn(async () => []),
    resolveTenantSheet: jest.fn(),
    serviceAccountEmail: () => "crm@projeto.iam.gserviceaccount.com",
    SheetAccessError,
  };
});
jest.mock("../services/cicloRefresh", () => ({ refreshCicloColumns: jest.fn(async () => undefined) }));
jest.mock("../services/notifications", () => ({ notify: jest.fn() }));

import router from "./imports";
import { runCardAccountImport } from "../services/cardAccountImport";
import { fetchSheetRows, resolveTenantSheet, SheetAccessError } from "../services/googleSheets";
import { runImport } from "../services/importService";
import { logTentativaAcesso } from "../middleware/audit";

const app = express();
app.use(express.json());
app.use("/imports", router);

const COMPRAS = ["IdTransacaoCartao", "DtConfirmada", "CpfCnpjCliente", "Descrição", "ValorPrincipal", "Juros"];
const CARTOES = ["CpfCnpjCliente", "NomeCliente", "Celular", "idCartao", "DtAtivacaoCartao", "LimiteDeCompras", "SaldoUtilizado"];
const LOTE = "7f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const rows = [{ documento: "52998224725", nome: "Maria", telefone: "84999998888" }];

describe("trava de formato no servidor", () => {
  beforeEach(() => jest.clearAllMocks());

  it("compras importadas como cartões e contas: 422 e nada é gravado", async () => {
    const r = await request(app).post("/imports/cartoes").send({ rows, cabecalhos: COMPRAS, loteId: LOTE });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ codigo: "FORMATO_INCOMPATIVEL", detectado: "compras", escolhido: "cartoes" });
    expect(runCardAccountImport).not.toHaveBeenCalled();
    const p = await request(app).post("/imports/cartoes/preview").send({ rows, cabecalhos: COMPRAS });
    expect(p.status).toBe(422);
  });

  it("formato certo passa e leva lote, nome do arquivo e o que o arquivo traz", async () => {
    const camposPresentes = { limite: true, saldo: false, utilizado: true, status: false };
    const r = await request(app).post("/imports/cartoes").send({ rows, cabecalhos: CARTOES, loteId: LOTE, nomeArquivo: "base.csv", camposPresentes });
    expect(r.status).toBe(200);
    expect((runCardAccountImport as jest.Mock).mock.calls[0][4]).toEqual({ presence: camposPresentes, loteId: LOTE, nomeArquivo: "base.csv" });
  });

  it("só ADMIN pode forçar; sem cabeçalhos (API antiga) não há conferência", async () => {
    const op = await request(app).post("/imports/cartoes").send({ rows, cabecalhos: COMPRAS, forcarFormato: true });
    expect(op.status).toBe(422);
    const admin = await request(app).post("/imports/cartoes").set("x-role", "ADMIN").send({ rows, cabecalhos: COMPRAS, forcarFormato: true });
    expect(admin.status).toBe(200);
    const semCab = await request(app).post("/imports/cartoes").send({ rows });
    expect(semCab.status).toBe(200);
  });

  it("desfazer é só para ADMIN", async () => {
    const r = await request(app).post(`/imports/lotes/${LOTE}/desfazer`);
    expect(r.status).toBe(403);
  });
});

describe("GET /imports/lotes", () => {
  it("agrupa por arquivo e marca só a última importação de clientes como desfazível", async () => {
    const T = new Date("2026-10-10T10:00:00Z").getTime();
    const j = (id: string, loteId: string, formato: string, minutos: number) => ({
      id, loteId, formato, nomeArquivo: `${loteId}.csv`, source: "csv", status: "CONCLUIDO", startedAt: new Date(T + minutos * 60_000), totalRows: 400, addedCount: 0, updatedCount: 400, errorCount: 0, desfeitaEm: null, tenantId: "t1",
    });
    importJobFindMany.mockResolvedValue([j("3", "C", "compras", 30), j("2", "B", "cartoes", 20), j("1", "A", "cartoes", 10)]);
    const r = await request(app).get("/imports/lotes");
    expect(r.status).toBe(200);
    expect(r.body.map((l: any) => [l.loteId, l.formatoNome])).toEqual([["C", "Compras"], ["B", "Cartões e contas"], ["A", "Cartões e contas"]]);
    // sem estado anterior guardado (importChange.count = 0), ninguém é desfazível
    expect(r.body.every((l: any) => l.podeDesfazer === false)).toBe(true);
  });
});

describe("POST /imports/google-sheets (LGPD 06-02)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("sheetId não cadastrado no tenant: recusa sem ler o Google, audita e mostra a Service Account", async () => {
    (resolveTenantSheet as jest.Mock).mockRejectedValue(new (SheetAccessError as any)(403, "PLANILHA_NAO_CADASTRADA", "não cadastrada"));
    const r = await request(app).post("/imports/google-sheets").send({ sheetId: "PLAN_DE_OUTRO" });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ codigo: "PLANILHA_NAO_CADASTRADA", serviceAccountEmail: "crm@projeto.iam.gserviceaccount.com" });
    expect((resolveTenantSheet as jest.Mock).mock.calls[0].slice(1)).toEqual(["t1", "PLAN_DE_OUTRO"]);
    expect(fetchSheetRows).not.toHaveBeenCalled();
    expect(runImport).not.toHaveBeenCalled();
    expect((logTentativaAcesso as jest.Mock).mock.calls[0][0]).toMatchObject({ tenantId: "t1", userId: "u1", action: "IMPORT_GOOGLE_SHEETS_NEGADO", details: { codigo: "PLANILHA_NAO_CADASTRADA", sheetIdPedido: "PLAN_DE_OUTRO" } });
  });

  it("sem sheetId lê a planilha cadastrada, com range e mapeamento do cadastro", async () => {
    (resolveTenantSheet as jest.Mock).mockResolvedValue({ id: "c1", tenantId: "t1", sheetId: "PLAN_A", sheetRange: "Base!A1:Z", columnMapping: { nome: "Nome" } });
    (runImport as jest.Mock).mockResolvedValue({ importJobId: "j9", result: { totalRows: 0 } });
    const r = await request(app).post("/imports/google-sheets").send({});
    expect(r.status).toBe(200);
    expect(fetchSheetRows).toHaveBeenCalledWith("PLAN_A", "Base!A1:Z", { nome: "Nome" });
    expect((runImport as jest.Mock).mock.calls[0][1]).toBe("t1");
    expect(r.body.serviceAccountEmail).toBe("crm@projeto.iam.gserviceaccount.com");
  });

  it("VIEWER/ANALYST continuam sem poder importar", async () => {
    const r = await request(app).post("/imports/google-sheets").set("x-role", "ANALYST").send({});
    expect(r.status).toBe(403);
    expect(resolveTenantSheet).not.toHaveBeenCalled();
  });
});

/**
 * LGPD 06-02: com uma Service Account única para todos os tenants, só a planilha CADASTRADA e
 * exclusiva do tenant pode ser lida/escrita; leitura usa escopo só-leitura.
 */
const sheetFindFirst = jest.fn();
const sheetFindMany = jest.fn();
jest.mock("../config/db", () => ({
  prisma: { sheetConnection: { findFirst: (a: any) => sheetFindFirst(a), findMany: (a: any) => sheetFindMany(a) } },
}));
jest.mock("../config/tenantGuard", () => ({ withCrossTenantAccess: (fn: () => any) => fn() }));

const valuesGet = jest.fn(async (_a?: any) => ({ data: { values: [["nome"], ["Maria"]] } }));
const ssGet = jest.fn(async (_a?: any) => ({ data: { sheets: [{ properties: { title: "CRM_Export" } }] } }));
const valuesClear = jest.fn(async (_a?: any) => ({}));
const valuesUpdate = jest.fn(async (_a?: any) => ({}));
const authScopes: string[][] = [];
jest.mock("googleapis", () => ({
  google: {
    auth: {
      GoogleAuth: jest.fn().mockImplementation((o: any) => {
        authScopes.push(o.scopes);
        return {};
      }),
    },
    sheets: () => ({
      spreadsheets: {
        get: (a: any) => ssGet(a),
        batchUpdate: jest.fn(),
        values: { get: (a: any) => valuesGet(a), clear: (a: any) => valuesClear(a), update: (a: any) => valuesUpdate(a) },
      },
    }),
  },
}));

import { prisma } from "../config/db";
import {
  assertPlanilhaExclusiva,
  extractSheetId,
  fetchSheetRows,
  resolveTenantSheet,
  SCOPE_ESCRITA,
  SCOPE_LEITURA,
  serviceAccountEmail,
  SheetAccessError,
  writeSheetSummary,
} from "./googleSheets";

const p = prisma as any;
const conn = (tenantId: string, sheetId = "PLAN_A") => ({ id: `c-${tenantId}`, tenantId, sheetId, sheetRange: "A1:Z", columnMapping: { nome: "nome" }, active: true });

beforeEach(() => {
  jest.clearAllMocks();
  authScopes.length = 0;
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: "crm@projeto.iam.gserviceaccount.com", private_key: "SEGREDO" });
});

describe("resolveTenantSheet", () => {
  it("sheetId arbitrário (não cadastrado no tenant) é recusado, mesmo compartilhado com a Service Account", async () => {
    sheetFindFirst.mockResolvedValue(null);
    await expect(resolveTenantSheet(p, "t1", "PLAN_DE_OUTRO")).rejects.toMatchObject({ status: 403, codigo: "PLANILHA_NAO_CADASTRADA" });
    expect(sheetFindFirst.mock.calls[0][0].where).toEqual({ tenantId: "t1", active: true, sheetId: "PLAN_DE_OUTRO" });
  });

  it("sem sheetId usa a planilha cadastrada do tenant; aceita link completo", async () => {
    sheetFindFirst.mockResolvedValue(conn("t1"));
    sheetFindMany.mockResolvedValue([{ tenantId: "t1" }]);
    await expect(resolveTenantSheet(p, "t1")).resolves.toMatchObject({ sheetId: "PLAN_A" });
    await resolveTenantSheet(p, "t1", "https://docs.google.com/spreadsheets/d/PLAN_A/edit#gid=0");
    expect(sheetFindFirst.mock.calls[1][0].where.sheetId).toBe("PLAN_A");
  });

  it("mesma planilha cadastrada em dois tenants: recusa (falha fechada, para ambos)", async () => {
    sheetFindFirst.mockResolvedValue(conn("t2"));
    sheetFindMany.mockResolvedValue([{ tenantId: "t1" }, { tenantId: "t2" }]);
    await expect(resolveTenantSheet(p, "t2")).rejects.toMatchObject({ status: 409, codigo: "PLANILHA_EM_OUTRO_CONTROLADOR" });
    sheetFindFirst.mockResolvedValue(conn("t1"));
    await expect(resolveTenantSheet(p, "t1")).rejects.toBeInstanceOf(SheetAccessError);
  });
});

describe("assertPlanilhaExclusiva", () => {
  it("planilha sem nenhum cadastro ativo é recusada", async () => {
    sheetFindMany.mockResolvedValue([]);
    await expect(assertPlanilhaExclusiva(p, "X")).rejects.toMatchObject({ codigo: "PLANILHA_NAO_CADASTRADA" });
  });

  it("cadastro de outro tenant não vale para este", async () => {
    sheetFindMany.mockResolvedValue([{ tenantId: "t2" }]);
    await expect(assertPlanilhaExclusiva(p, "X", "t1")).rejects.toMatchObject({ codigo: "PLANILHA_NAO_CADASTRADA" });
  });

  it("vários cadastros do mesmo tenant contam como um dono", async () => {
    sheetFindMany.mockResolvedValue([{ tenantId: "t1" }, { tenantId: "t1" }]);
    await expect(assertPlanilhaExclusiva(p, "X", "t1")).resolves.toBeUndefined();
  });
});

describe("fetchSheetRows / writeSheetSummary", () => {
  it("leitura usa escopo só-leitura e confere a exclusividade antes de chamar o Google", async () => {
    sheetFindMany.mockResolvedValue([{ tenantId: "t1" }]);
    const rows = await fetchSheetRows("PLAN_A", "A1:Z", { nome: "nome" });
    expect(rows).toEqual([{ nome: "Maria" }]);
    expect(authScopes).toEqual([[SCOPE_LEITURA]]);
    expect(sheetFindMany.mock.calls[0][0].where).toEqual({ sheetId: "PLAN_A", active: true });
  });

  it("sync agendado não lê planilha cadastrada em dois tenants", async () => {
    sheetFindMany.mockResolvedValue([{ tenantId: "t1" }, { tenantId: "t2" }]);
    await expect(fetchSheetRows("PLAN_A", "A1:Z", {})).rejects.toMatchObject({ status: 409 });
    expect(valuesGet).not.toHaveBeenCalled();
  });

  it("só o export BI usa escopo de escrita, e não escreve em planilha disputada", async () => {
    sheetFindMany.mockResolvedValue([{ tenantId: "t1" }]);
    await writeSheetSummary("PLAN_A", "CRM_Export", [["a"]]);
    expect(authScopes).toEqual([[SCOPE_ESCRITA]]);

    sheetFindMany.mockResolvedValue([{ tenantId: "t1" }, { tenantId: "t2" }]);
    valuesUpdate.mockClear();
    await expect(writeSheetSummary("PLAN_A", "CRM_Export", [["a"]])).rejects.toMatchObject({ status: 409 });
    expect(valuesUpdate).not.toHaveBeenCalled();
  });
});

describe("serviceAccountEmail / extractSheetId", () => {
  it("devolve só o e-mail, nunca a chave", () => {
    expect(serviceAccountEmail()).toBe("crm@projeto.iam.gserviceaccount.com");
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    expect(serviceAccountEmail()).toBeNull();
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = "{inválido";
    expect(serviceAccountEmail()).toBeNull();
  });

  it("extrai o id do link", () => {
    expect(extractSheetId(" https://docs.google.com/spreadsheets/d/abc-_12/edit ")).toBe("abc-_12");
    expect(extractSheetId("abc")).toBe("abc");
  });
});

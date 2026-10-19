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

// Chamadas ao Google: escopo, método e URL de cada uma (o cliente HTTP em si é testado em googleApi.test.ts)
const chamadas: { scope: string; method: string; url: string; body?: any }[] = [];
const respostas: Record<string, any> = {};
jest.mock("./googleApi", () => ({
  googleFetch: jest.fn(async (scope: string, url: string, init: { method?: string; body?: unknown } = {}) => {
    const method = init.method ?? "GET";
    chamadas.push({ scope, method, url, body: init.body });
    if (url.includes("/values/") && method === "GET") return respostas.values ?? { values: [["nome"], ["Maria"]] };
    if (url.includes("?fields=")) return respostas.meta ?? { sheets: [{ properties: { title: "CRM_Export" } }] };
    return {};
  }),
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
  chamadas.length = 0;
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
    expect(chamadas).toEqual([{ scope: SCOPE_LEITURA, method: "GET", url: "https://sheets.googleapis.com/v4/spreadsheets/PLAN_A/values/A1%3AZ", body: undefined }]);
    expect(sheetFindMany.mock.calls[0][0].where).toEqual({ sheetId: "PLAN_A", active: true });
  });

  it("sync agendado não lê planilha cadastrada em dois tenants", async () => {
    sheetFindMany.mockResolvedValue([{ tenantId: "t1" }, { tenantId: "t2" }]);
    await expect(fetchSheetRows("PLAN_A", "A1:Z", {})).rejects.toMatchObject({ status: 409 });
    expect(chamadas).toHaveLength(0);
  });

  it("só o export BI usa escopo de escrita, e não escreve em planilha disputada", async () => {
    sheetFindMany.mockResolvedValue([{ tenantId: "t1" }]);
    await writeSheetSummary("PLAN_A", "CRM_Export", [["a"]]);
    expect(chamadas.every((c) => c.scope === SCOPE_ESCRITA)).toBe(true);
    // aba já existe: lê as abas, limpa e escreve a partir de A1
    expect(chamadas.map((c) => `${c.method} ${c.url.replace("https://sheets.googleapis.com/v4/spreadsheets/", "")}`)).toEqual([
      "GET PLAN_A?fields=sheets.properties.title",
      "POST PLAN_A/values/CRM_Export:clear",
      "PUT PLAN_A/values/CRM_Export!A1?valueInputOption=RAW",
    ]);
    expect(chamadas[2].body).toEqual({ values: [["a"]] });

    sheetFindMany.mockResolvedValue([{ tenantId: "t1" }, { tenantId: "t2" }]);
    chamadas.length = 0;
    await expect(writeSheetSummary("PLAN_A", "CRM_Export", [["a"]])).rejects.toMatchObject({ status: 409 });
    expect(chamadas).toHaveLength(0);
  });

  it("export BI cria a aba quando ela não existe", async () => {
    sheetFindMany.mockResolvedValue([{ tenantId: "t1" }]);
    respostas.meta = { sheets: [{ properties: { title: "Base" } }] };
    await writeSheetSummary("PLAN_A", "CRM_Export", [["a"]]);
    delete respostas.meta;
    expect(chamadas[1]).toMatchObject({ method: "POST", url: expect.stringMatching(/PLAN_A:batchUpdate$/), body: { requests: [{ addSheet: { properties: { title: "CRM_Export" } } }] } });
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

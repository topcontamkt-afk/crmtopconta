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
    if (url.includes("values:batchGet")) return respostas.batch ?? { valueRanges: [] };
    if (url.includes("/values/") && method === "GET") return respostas.values ?? { values: [["nome"], ["Maria"]] };
    if (url.includes("?fields=")) return respostas.meta ?? { sheets: [{ properties: { title: "CRM_Export" } }] };
    return {};
  }),
}));

import { prisma } from "../config/db";
import {
  assertPlanilhaExclusiva,
  extractSheetId,
  fetchSheetPage,
  fetchSheetRows,
  paginaDoRange,
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

describe("paginaDoRange (sync em páginas)", () => {
  it("range padrão: cabeçalho na linha 1, páginas a partir da 2", () => {
    expect(paginaDoRange("A1:Z", 0, 200)).toEqual({ cabecalho: "A1:Z1", pagina: "A2:Z201", primeiraLinha: 2 });
    expect(paginaDoRange("A1:Z", 200, 200)).toEqual({ cabecalho: "A1:Z1", pagina: "A202:Z401", primeiraLinha: 202 });
  });

  it("mantém a aba (com aspas e espaço) e o cabeçalho fora da linha 1", () => {
    expect(paginaDoRange("'Minha aba'!B3:K", 0, 10)).toEqual({ cabecalho: "'Minha aba'!B3:K3", pagina: "'Minha aba'!B4:K13", primeiraLinha: 4 });
    expect(paginaDoRange("Base!a1:z", 0, 5)!.pagina).toBe("Base!A2:Z6");
  });

  it("respeita a linha final do range e devolve null depois dela", () => {
    expect(paginaDoRange("A1:Z250", 200, 200)!.pagina).toBe("A202:Z250");
    expect(paginaDoRange("A1:Z250", 400, 200)).toBeNull();
  });

  it("range de uma coluna só e range inválido", () => {
    expect(paginaDoRange("A1", 0, 3)).toEqual({ cabecalho: "A1:A1", pagina: "A2:A4", primeiraLinha: 2 });
    expect(() => paginaDoRange("Aba!", 0, 3)).toThrow(/inválido/);
  });
});

describe("fetchSheetPage", () => {
  beforeEach(() => {
    chamadas.length = 0;
    sheetFindMany.mockResolvedValue([conn("t1")]);
  });

  it("cabeçalho e página numa chamada só (batchGet, escopo de leitura) e mapeia pelo cabeçalho", async () => {
    respostas.batch = { valueRanges: [{ values: [["telefone", "nome"]] }, { values: [["8499", "Ana"], ["8498", "Bia"]] }] };
    const r = await fetchSheetPage("PLAN_A", "Base!A1:Z", { nome: "nome", telefone: "telefone" } as any, 200, 200);
    expect(r).toEqual({ linhas: [{ telefone: "8499", nome: "Ana" }, { telefone: "8498", nome: "Bia" }], primeiraLinha: 202 });
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0].scope).toBe(SCOPE_LEITURA);
    expect(decodeURIComponent(chamadas[0].url)).toContain("values:batchGet?ranges=Base!A1:Z1&ranges=Base!A202:Z401");
  });

  it("página sem linhas = acabou", async () => {
    respostas.batch = { valueRanges: [{ values: [["nome"]] }, {}] };
    await expect(fetchSheetPage("PLAN_A", "A1:Z", { nome: "nome" } as any, 400, 200)).resolves.toEqual({ linhas: [], primeiraLinha: 402 });
  });

  it("planilha cadastrada em dois tenants: recusa antes de ler", async () => {
    sheetFindMany.mockResolvedValue([conn("t1"), conn("t2")]);
    await expect(fetchSheetPage("PLAN_A", "A1:Z", { nome: "nome" } as any, 0, 200)).rejects.toBeInstanceOf(SheetAccessError);
    expect(chamadas).toHaveLength(0);
  });
});

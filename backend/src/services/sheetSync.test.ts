/**
 * Sync da planilha em páginas pela fila: encadeamento, totais, fim, teto de páginas, retry e o modo sem fila.
 * A leitura do Google (googleSheets.test.ts) e a importação (importService.test.ts) são testadas à parte.
 */
const updateMany = jest.fn(async (_a: any) => ({ count: 1 }));
jest.mock("../config/db", () => ({ prisma: { sheetConnection: { updateMany: (a: any) => updateMany(a) } } }));
jest.mock("../config/tenantGuard", () => ({ runWithTenantContextAsync: (_t: string, fn: () => any) => fn() }));
jest.mock("../middleware/audit", () => ({ logAudit: jest.fn(async () => undefined) }));
jest.mock("./cicloRefresh", () => ({ refreshCicloColumns: jest.fn(async () => 0) }));
jest.mock("./notifications", () => ({ notify: jest.fn(async () => undefined) }));
jest.mock("./importService", () => ({
  runImport: jest.fn(async (_p: any, _t: string, rows: any[]) => ({
    importJobId: "job",
    result: { addedCount: rows.length, updatedCount: 0, errorCount: 1 },
  })),
}));
jest.mock("./googleSheets", () => ({
  resolveTenantSheet: jest.fn(async () => ({ sheetId: "PLAN_A" })),
  fetchSheetPage: jest.fn(),
  fetchSheetRows: jest.fn(async () => [{ nome: "Ana" }]),
}));

import { logAudit } from "../middleware/audit";
import { refreshCicloColumns } from "./cicloRefresh";
import { fetchSheetPage, fetchSheetRows, resolveTenantSheet } from "./googleSheets";
import { runImport } from "./importService";
import { notify } from "./notifications";
import {
  configureSyncQueue,
  iniciarSyncPlanilha,
  PaginaSync,
  processarPaginaSync,
  SYNC_CHUNK,
  SYNC_MAX_PAGINAS,
  SYNC_MAX_TENTATIVAS,
  tratarMensagemSync,
} from "./sheetSync";

const linhas = (n: number) => Array.from({ length: n }, (_, i) => ({ nome: `L${i}` }));
const pedido = { tenantId: "t1", sheetId: "PLAN_A", range: "A1:Z", mapping: { nome: "nome" } as any, triggeredBy: "u1", userId: "u1" };
const msg = (over: Partial<PaginaSync> = {}): PaginaSync => ({
  ...pedido,
  inicio: 0,
  loteId: "lote-1",
  totais: { paginas: 0, linhas: 0, adicionados: 0, atualizados: 0, erros: 0 },
  ...over,
});

let enviadas: PaginaSync[];
beforeEach(() => {
  jest.clearAllMocks();
  enviadas = [];
  configureSyncQueue({ send: async (m) => void enviadas.push(m) });
});
afterAll(() => configureSyncQueue(null));

describe("iniciarSyncPlanilha", () => {
  it("com fila: só enfileira a 1ª página (sem ler a planilha nem dado dela na mensagem)", async () => {
    const r = await iniciarSyncPlanilha(pedido);
    expect(r.enfileirado).toBe(true);
    expect(enviadas).toEqual([msg({ loteId: (r as any).loteId })]);
    expect(fetchSheetRows).not.toHaveBeenCalled();
    expect(runImport).not.toHaveBeenCalled();
  });

  it("sem fila: importa a planilha inteira na hora e grava lastSyncAt", async () => {
    configureSyncQueue(null);
    const r = await iniciarSyncPlanilha(pedido);
    expect(r).toMatchObject({ enfileirado: false, importJobId: "job" });
    expect(runImport).toHaveBeenCalledWith(expect.anything(), "t1", [{ nome: "Ana" }], "u1", "google_sheets", "PLAN_A");
    expect(updateMany).toHaveBeenCalledWith({ where: { tenantId: "t1", sheetId: "PLAN_A", active: true }, data: { lastSyncAt: expect.any(Date) } });
    expect(refreshCicloColumns).toHaveBeenCalledWith("t1");
  });
});

describe("processarPaginaSync", () => {
  it("página cheia: importa com lote e nº de linha da página e enfileira a próxima com os totais", async () => {
    (fetchSheetPage as jest.Mock).mockResolvedValue({ linhas: linhas(SYNC_CHUNK), primeiraLinha: 202 });
    await expect(processarPaginaSync(msg({ inicio: SYNC_CHUNK }))).resolves.toEqual({ proxima: true });
    expect(resolveTenantSheet).toHaveBeenCalledWith(expect.anything(), "t1", "PLAN_A");
    expect(fetchSheetPage).toHaveBeenCalledWith("PLAN_A", "A1:Z", { nome: "nome" }, SYNC_CHUNK, SYNC_CHUNK);
    expect((runImport as jest.Mock).mock.calls[0][6]).toEqual({ loteId: "lote-1", primeiraLinha: 202 });
    expect(enviadas).toEqual([
      msg({ inicio: 2 * SYNC_CHUNK, totais: { paginas: 1, linhas: SYNC_CHUNK, adicionados: SYNC_CHUNK, atualizados: 0, erros: 1 } }),
    ]);
    expect(updateMany).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("última página (incompleta): conclui, grava lastSyncAt e audita os totais do lote", async () => {
    (fetchSheetPage as jest.Mock).mockResolvedValue({ linhas: linhas(3), primeiraLinha: 402 });
    const totais = { paginas: 2, linhas: 400, adicionados: 10, atualizados: 390, erros: 0 };
    await expect(processarPaginaSync(msg({ inicio: 400, totais }))).resolves.toEqual({ proxima: false });
    expect(enviadas).toEqual([]);
    expect(updateMany).toHaveBeenCalled();
    expect(refreshCicloColumns).toHaveBeenCalledWith("t1");
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "IMPORT_GOOGLE_SHEETS",
        targetId: "lote-1",
        userId: "u1",
        details: { paginas: 3, linhas: 403, adicionados: 13, atualizados: 390, erros: 1, enfileirado: true },
      })
    );
    expect(notify).not.toHaveBeenCalled();
  });

  it("página vazia (planilha com múltiplo exato de 200 linhas): conclui sem importar", async () => {
    (fetchSheetPage as jest.Mock).mockResolvedValue({ linhas: [], primeiraLinha: 402 });
    await expect(processarPaginaSync(msg({ inicio: 400 }))).resolves.toEqual({ proxima: false });
    expect(runImport).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalled();
  });

  it("teto de páginas: para, conclui e avisa o tenant", async () => {
    (fetchSheetPage as jest.Mock).mockResolvedValue({ linhas: linhas(SYNC_CHUNK), primeiraLinha: 2 });
    const totais = { paginas: SYNC_MAX_PAGINAS - 1, linhas: 0, adicionados: 0, atualizados: 0, erros: 0 };
    await expect(processarPaginaSync(msg({ totais }))).resolves.toEqual({ proxima: false });
    expect(enviadas).toEqual([]);
    expect(notify).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: "IMPORT_FAILED", tenantId: "t1" }));
  });

  it("planilha descadastrada no meio do sync: erro antes de ler o Google", async () => {
    (resolveTenantSheet as jest.Mock).mockRejectedValueOnce(new Error("não cadastrada"));
    await expect(processarPaginaSync(msg())).rejects.toThrow("não cadastrada");
    expect(fetchSheetPage).not.toHaveBeenCalled();
  });
});

describe("tratarMensagemSync", () => {
  beforeEach(() => jest.spyOn(console, "error").mockImplementation(() => undefined));

  it("erro antes da última tentativa: retry, sem avisar", async () => {
    (fetchSheetPage as jest.Mock).mockRejectedValue(new Error("Google 503"));
    await expect(tratarMensagemSync(msg(), 1)).resolves.toBe("retry");
    expect(notify).not.toHaveBeenCalled();
  });

  it("erro na última tentativa: avisa o tenant e tira da fila", async () => {
    (fetchSheetPage as jest.Mock).mockRejectedValue(new Error("Google 503"));
    await expect(tratarMensagemSync(msg({ inicio: 200 }), SYNC_MAX_TENTATIVAS)).resolves.toBe("ok");
    expect(notify).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: "IMPORT_FAILED", message: expect.stringContaining("linha 202") }));
  });

  it("sucesso: ok", async () => {
    (fetchSheetPage as jest.Mock).mockResolvedValue({ linhas: [], primeiraLinha: 2 });
    await expect(tratarMensagemSync(msg(), 1)).resolves.toBe("ok");
  });
});

describe("wrangler.jsonc", () => {
  it("max_retries do consumidor = SYNC_MAX_TENTATIVAS - 1, uma mensagem por invocação, em todo ambiente", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { join } = require("node:path");
    const cfg = JSON.parse(readFileSync(join(__dirname, "../../wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, ""));
    for (const amb of [cfg, ...Object.values(cfg.env ?? {})] as any[]) {
      const [prod] = amb.queues.producers;
      const [cons] = amb.queues.consumers;
      expect(prod.binding).toBe("SYNC_QUEUE");
      expect(cons.queue).toBe(prod.queue);
      expect(cons.max_batch_size).toBe(1);
      expect(cons.max_retries).toBe(SYNC_MAX_TENTATIVAS - 1);
    }
  });
});

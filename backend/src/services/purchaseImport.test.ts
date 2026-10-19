const execute = jest.fn(async (..._a: any[]) => 0);
jest.mock("../config/db", () => ({ tenantRaw: { execute: (...a: any[]) => execute(...a), query: jest.fn() } }));
jest.mock("./usageRefresh", () => ({ refreshUsageColumns: jest.fn(async () => undefined) }));

import { runPurchaseImport } from "./purchaseImport";
import { hashDocument } from "./masking";

/** LGPD 03-04: o extrato não alimenta cliente com o tratamento suspenso a pedido do titular. */
describe("runPurchaseImport — cliente bloqueado (LGPD 03-04)", () => {
  const SALT = "salt-t1";
  const linha = (id: string, doc: string) => ({ id_transacao: id, data: "10/10/2026", documento: doc, descricao: "Débito Pix Cartão", valor_principal: "100" });

  it("ignora as compras do bloqueado (não grava nem avança o último uso) e conta à parte", async () => {
    const prisma: any = {
      tenant: { findUniqueOrThrow: jest.fn(async () => ({ id: "t1", cpfSalt: SALT })) },
      importJob: { create: jest.fn(async () => ({ id: "j1" })), update: jest.fn(async () => ({})) },
      client: {
        findMany: jest.fn(async () => [
          { id: "livre", cpfHash: hashDocument("52998224725", SALT), bloqueadoLgpdAt: null },
          { id: "bloq", cpfHash: hashDocument("11144477735", SALT), bloqueadoLgpdAt: new Date() },
        ]),
      },
      merchant: { findMany: jest.fn(async () => []), createMany: jest.fn() },
      purchase: { createMany: jest.fn(async ({ data }: any) => ({ count: data.length })) },
    };
    const { result } = await runPurchaseImport(prisma, "t1", [linha("a", "529.982.247-25"), linha("b", "111.444.777-35")], "u1");

    const gravadas = prisma.purchase.createMany.mock.calls[0][0].data;
    expect(gravadas.map((p: any) => p.clientId)).toEqual(["livre"]);
    expect(execute.mock.calls[0][2]).toEqual(["livre"]); // último uso só do cliente liberado
    expect(result).toMatchObject({ importedCount: 1, bloqueadasLgpd: 1, unmatchedRows: 0 });
    expect(result.errors[0].motivo).toContain("tratamento suspenso");
  });
});

jest.mock("../config/db", () => ({ prisma: {}, tenantRaw: { query: jest.fn(), execute: jest.fn() } }));

import { runRule } from "./automationEngine";
import { phoneHash } from "./privacy";

/**
 * LGPD 02-03: gatilhos de contato excluem o tratamento bloqueado (`bloqueadoLgpdAt`) no banco e os telefones
 * suprimidos (pedido feito por outro cadastro ou por contato de lista) depois da consulta.
 */
const SALT = "salt-t1";
function fakePrisma(clients: any[], supressoes: any[] = []) {
  return {
    client: { findMany: jest.fn(async ({ where }: any) => (where.optOutAt?.not !== undefined ? [] : clients)) },
    movement: { findMany: jest.fn(async () => clients.map((c) => ({ clientId: c.id, client: { telefone: c.telefone, cpfHash: c.cpfHash } }))) },
    tenant: { findUnique: jest.fn(async () => ({ cpfSalt: SALT })) },
    supressaoTitular: { findMany: jest.fn(async () => supressoes) },
    campaignRecipient: { findMany: jest.fn(async () => []) },
    automationRule: { update: jest.fn() },
  } as any;
}
const clients = [
  { id: "c1", telefone: "+5584999998888", cpfHash: "d1" },
  { id: "c2", telefone: "+5584988887777", cpfHash: "d2" },
];
const sup = [{ tenantId: "t1", phoneHash: phoneHash(SALT, "+558488887777"), docHash: null, motivo: "OPT_OUT" }];
const rule = (trigger: string, condition: any = {}) => ({ id: "r1", tenantId: "t1", name: "R", trigger, condition, action: { type: "notification" } });

describe("automationEngine — supressão e bloqueio do titular", () => {
  it.each([
    ["NOVO_CLIENTE_SEM_USO", {}],
    ["INATIVO_30_DIAS", {}],
    ["ESTIMULO_FAIXA", { faixa: "BAIXO" }],
    ["LIMITE_RENOVADO", {}],
  ])("%s: telefone suprimido sai do público e o filtro do banco exige bloqueadoLgpdAt nulo", async (trigger, condition) => {
    const prisma = fakePrisma(clients, sup);
    const r: any = await runRule(prisma, rule(trigger, condition), { simular: true });
    expect(r.matched).toBe(1);
    const call = trigger === "LIMITE_RENOVADO" ? prisma.movement.findMany.mock.calls[0][0].where.client : prisma.client.findMany.mock.calls[0][0].where;
    expect(call).toMatchObject({ bloqueadoLgpdAt: null, optOutAt: null, autorizacaoComunicacao: true });
  });

  it("sem supressão, todos casam", async () => {
    const prisma = fakePrisma(clients);
    const r: any = await runRule(prisma, rule("INATIVO_30_DIAS"), { simular: true });
    expect(r.matched).toBe(2);
  });
});

jest.mock("../config/db", () => ({ prisma: {}, tenantRaw: { query: jest.fn(), execute: jest.fn() } }));
jest.mock("./notifications", () => ({ notify: jest.fn(async () => undefined) }));
jest.mock("../middleware/audit", () => ({ logAudit: jest.fn(async () => undefined) }));
jest.mock("./campaignQueue", () => ({
  enqueueCampaign: jest.fn(async () => ({ queued: 2 })),
  processQueueBatch: jest.fn(async () => ({ processed: 2, remaining: 0 })),
}));

import { runRule } from "./automationEngine";
import { phoneHash } from "./privacy";
import { AVISO_RENDA_IGNORADA } from "./segments";
import { enqueueCampaign } from "./campaignQueue";

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

describe("LGPD 01-03: renda não é critério de gatilho", () => {
  it("ETAPA_PERFIL só com perfilRenda não dispara (nem consulta clientes)", async () => {
    const prisma = fakePrisma(clients);
    const r: any = await runRule(prisma, rule("ETAPA_PERFIL", { perfilRenda: "PF1" }), { simular: true });
    expect(r.matched).toBe(0);
    expect(prisma.client.findMany).not.toHaveBeenCalled();
  });

  it.each([
    ["CICLO_ABERTO", { perfilRenda: "PF4" }],
    ["ETAPA_PERFIL", { etapaUso: "RECORRENTE", perfilRenda: ["PF1"] }],
  ])("%s com perfilRenda: não dispara e diz o motivo (sem o filtro, o público seria maior)", async (trigger, condition) => {
    const prisma = fakePrisma([{ ...clients[0], cidade: "Natal" }]);
    prisma.cicloCidade = { findMany: jest.fn(async () => [{ cidadeKey: "natal", cidade: "Natal", diaAbertura: 1 }]) };
    for (const simular of [true, false]) {
      const r: any = await runRule(prisma, { ...rule(trigger, condition), action: { type: "campaign", messageTemplate: "Oi" } }, { simular });
      expect(r).toMatchObject({ matched: 0, executed: false, reason: AVISO_RENDA_IGNORADA });
    }
    expect(prisma.client.findMany).not.toHaveBeenCalled();
    expect(enqueueCampaign).not.toHaveBeenCalled();
  });
});

describe("LGPD 02-01: automação de campanha confere a base legal", () => {
  const campanha = (r: any) => ({ ...r, action: { type: "campaign", messageTemplate: "Oi {{nome}}" } });

  it("sem base legal declarada não cria campanha e avisa", async () => {
    const prisma = fakePrisma(clients);
    prisma.tenant.findUnique = jest.fn(async () => ({ cpfSalt: SALT, baseLegalMarketing: null }));
    prisma.campaign = { create: jest.fn(), findFirst: jest.fn(async () => null) };
    const r: any = await runRule(prisma, campanha(rule("INATIVO_30_DIAS")));
    expect(prisma.campaign.create).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).toContain("sem base legal declarada");
    const { notify } = jest.requireMock("./notifications");
    expect(notify).toHaveBeenCalledWith(prisma, expect.objectContaining({ type: "AUTOMATION_BLOCKED" }));
  });

  it("com base legal, grava a base vigente na campanha criada", async () => {
    const prisma = fakePrisma(clients);
    prisma.tenant.findUnique = jest.fn(async () => ({ cpfSalt: SALT, baseLegalMarketing: "LEGITIMO_INTERESSE" }));
    prisma.campaign = { create: jest.fn(async ({ data }: any) => ({ id: "cp1", ...data })), findFirst: jest.fn(async () => null) };
    await runRule(prisma, campanha(rule("INATIVO_30_DIAS")));
    expect(prisma.campaign.create.mock.calls[0][0].data.baseLegal).toBe("LEGITIMO_INTERESSE");
  });
});

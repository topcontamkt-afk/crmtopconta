jest.mock("../config/db", () => ({ prisma: {}, tenantRaw: { query: jest.fn(), execute: jest.fn() } }));

import { runRule } from "./automationEngine";

const HOJE_15 = new Date("2026-10-15T12:00:00Z"); // dia 15 em Brasília

function fakePrisma(opts: { configs: any[]; clients: any[] }) {
  return {
    cicloCidade: { findMany: jest.fn().mockResolvedValue(opts.configs) },
    client: { findMany: jest.fn().mockResolvedValue(opts.clients) },
    purchase: { aggregate: jest.fn().mockResolvedValue({ _max: { occurredAt: new Date() } }) },
    automationRule: { update: jest.fn() },
  } as any;
}

const configs = [
  { cidadeKey: "natal", cidade: "Natal", diaAbertura: 6 },
  { cidadeKey: "luziânia", cidade: "Luziânia", diaAbertura: 15 },
  { cidadeKey: "lagarto", cidade: "Lagarto", diaAbertura: 15 },
];
const clients = [
  { id: "c1", cidade: "Luziânia" },
  { id: "c2", cidade: "Luziânia" },
  { id: "c3", cidade: "Lagarto" },
];
const rule = (condition: any) => ({ id: "r1", tenantId: "t1", name: "Ciclo", trigger: "CICLO_ABERTO", condition, action: { type: "notification" } });

describe("gatilho CICLO_ABERTO", () => {
  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(HOJE_15);
  });
  afterAll(() => jest.useRealTimers());

  it("só as cidades que abrem hoje, um grupo por cidade", async () => {
    const prisma = fakePrisma({ configs, clients });
    const r: any = await runRule(prisma, rule({}), { simular: true });
    expect(r.grupos).toEqual([
      { label: "Luziânia", total: 2 },
      { label: "Lagarto", total: 1 },
    ]);
    expect(r.matched).toBe(3);
    // o filtro de banco usa o dia 15 (Natal, dia 6, fica de fora)
    const where = prisma.client.findMany.mock.calls[0][0].where;
    expect(JSON.stringify(where)).toContain('"diaCicloAbertura":{"in":[15]}');
  });

  it("filtra por cidades escolhidas", async () => {
    const prisma = fakePrisma({ configs, clients });
    const r: any = await runRule(prisma, rule({ cidades: ["lagarto"] }), { simular: true });
    expect(r.grupos).toEqual([{ label: "Lagarto", total: 1 }]);
  });

  it("diasAposAbertura 1: quem abriu ontem (dia 14 → ninguém hoje)", async () => {
    const prisma = fakePrisma({ configs, clients: [] });
    const r: any = await runRule(prisma, rule({ diasAposAbertura: 1 }), { simular: true });
    expect(r.matched).toBe(0);
    expect(prisma.client.findMany).not.toHaveBeenCalled();
  });

  it("executa a ação por cidade e marca lastRunAt", async () => {
    const prisma = fakePrisma({ configs, clients });
    prisma.notification = { create: jest.fn() };
    const r: any = await runRule(prisma, rule({}));
    expect(r.executed).toBe(true);
    expect(r.grupos).toHaveLength(2);
    expect(prisma.notification.create).toHaveBeenCalledTimes(2);
    expect(prisma.automationRule.update).toHaveBeenCalled();
  });
});

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { configureDatabase, prisma, tenantRaw } from "./db";
import { runWithTenantContextAsync, withCrossTenantAccess } from "./tenantGuard";
import { migrationStatements } from "./d1Migrations";

/**
 * Isolamento por tenant contra um SQLite de verdade, com as mesmas migrations do D1
 * (migrations/) e o mesmo client do Prisma 7. Dois tenants com os mesmos tipos de dado;
 * toda operação roda no contexto do tenant A e nunca pode ler, mudar ou apagar o que é do B.
 */

const dbFile = join(tmpdir(), `crm-isolamento-${randomUUID()}.sqlite`);
const ids: Record<string, { A: string; B: string }> = {};
let tA = "";
let tB = "";

const asA = <T>(fn: () => Promise<T>) => runWithTenantContextAsync(tA, fn);

beforeAll(async () => {
  configureDatabase(() => new PrismaBetterSqlite3({ url: `file:${dbFile}` }));
  await withCrossTenantAccess(async () => {
    for (const stmt of migrationStatements()) {
      await prisma.$executeRawUnsafe(stmt);
    }
    const [a, b] = [await prisma.tenant.create({ data: { name: "A" } }), await prisma.tenant.create({ data: { name: "B" } })];
    tA = a.id;
    tB = b.id;
    for (const [lado, tenantId] of [["A", a.id], ["B", b.id]] as const) {
      const client = await prisma.client.create({
        data: { tenantId, nome: `Cliente ${lado}`, telefone: `+55849999900${lado === "A" ? "01" : "02"}`, cpfHash: `h-${lado}`, cpfMasked: "***" },
      });
      const tag = await prisma.clientTag.create({ data: { tenantId, clientId: client.id, tag: "vip" } });
      const movement = await prisma.movement.create({ data: { tenantId, clientId: client.id, tipo: "renovacao_limite", valor: 100, data: new Date() } });
      const campaign = await prisma.campaign.create({ data: { tenantId, name: `Campanha ${lado}`, channel: "WHATSAPP", messageTemplate: "oi" } });
      const event = await prisma.messageEvent.create({ data: { tenantId, campaignId: campaign.id, clientId: client.id, channel: "WHATSAPP" } });
      const notification = await prisma.notification.create({ data: { tenantId, type: "IMPORT_FAILED", message: `aviso ${lado}` } });
      const pares: Record<string, string> = { client: client.id, clientTag: tag.id, movement: movement.id, campaign: campaign.id, messageEvent: event.id, notification: notification.id };
      for (const [k, id] of Object.entries(pares)) (ids[k] ??= { A: "", B: "" })[lado] = id;
    }
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(dbFile, { force: true });
});

/** Por model: como criar uma linha nova e qual campo alterar, sem depender de outro registro do B. */
const MODELS: Record<string, { create: () => Record<string, unknown>; update: Record<string, unknown> }> = {
  client: { create: () => ({ nome: "Novo", telefone: `+5584${Date.now()}`, cpfHash: randomUUID(), cpfMasked: "***" }), update: { nome: "Alterado" } },
  clientTag: { create: () => ({ clientId: ids.client.A, tag: randomUUID() }), update: { tag: "alterada" } },
  movement: { create: () => ({ clientId: ids.client.A, tipo: "x", valor: 1, data: new Date() }), update: { tipo: "alterado" } },
  campaign: { create: () => ({ name: "Nova", channel: "SMS", messageTemplate: "x" }), update: { name: "Alterada" } },
  messageEvent: { create: () => ({ campaignId: ids.campaign.A, channel: "SMS" }), update: { error: "alterado" } },
  notification: { create: () => ({ type: "x", message: "nova" }), update: { message: "alterada" } },
};

/** Estado das linhas do B, lido fora do contexto, para provar que nada mudou. */
const linhasDoB = (model: string) =>
  withCrossTenantAccess(() => (prisma as any)[model].findMany({ where: { tenantId: tB }, orderBy: { id: "asc" } }));

describe.each(Object.keys(MODELS))("%s: tenant A não enxerga nem altera o tenant B", (model) => {
  const d = () => (prisma as any)[model];

  it("leitura: por id, primeira, lista, contagem, agregação e agrupamento", async () => {
    await asA(async () => {
      expect(await d().findUnique({ where: { id: ids[model].B } })).toBeNull();
      expect(await d().findUnique({ where: { id: ids[model].A } })).not.toBeNull();
      await expect(d().findUniqueOrThrow({ where: { id: ids[model].B } })).rejects.toThrow();
      expect(await d().findFirst({ where: { id: ids[model].B } })).toBeNull();
      const todos = await d().findMany();
      expect(todos.length).toBeGreaterThan(0);
      expect(todos.every((r: any) => r.tenantId === tA)).toBe(true);
      expect(await d().count()).toBe(todos.length);
      expect((await d().aggregate({ _count: { _all: true } }))._count._all).toBe(todos.length);
      const grupos = await d().groupBy({ by: ["tenantId"], _count: { _all: true } });
      expect(grupos.map((g: any) => g.tenantId)).toEqual([tA]);
    });
  });

  it("pedir o tenant B explicitamente é erro, não lista vazia", async () => {
    await asA(async () => {
      await expect(d().findMany({ where: { tenantId: tB } })).rejects.toThrow(/tenantGuard/);
    });
  });

  it("escrita por id do B: update e delete falham, updateMany e deleteMany não acham nada", async () => {
    const antes = await linhasDoB(model);
    await asA(async () => {
      await expect(d().update({ where: { id: ids[model].B }, data: MODELS[model].update })).rejects.toThrow();
      expect((await d().updateMany({ where: { id: ids[model].B }, data: MODELS[model].update })).count).toBe(0);
      await expect(d().delete({ where: { id: ids[model].B } })).rejects.toThrow();
      expect((await d().deleteMany({ where: { id: ids[model].B } })).count).toBe(0);
    });
    expect(await linhasDoB(model)).toEqual(antes);
  });

  it("updateMany e deleteMany sem filtro só tocam o tenant A", async () => {
    const antes = await linhasDoB(model);
    await asA(async () => {
      const total = await d().count();
      expect((await d().updateMany({ data: MODELS[model].update })).count).toBe(total);
    });
    expect(await linhasDoB(model)).toEqual(antes);
  });

  it("create sem tenantId grava no A; com tenantId do B é recusado", async () => {
    await asA(async () => {
      const novo = await d().create({ data: MODELS[model].create() });
      expect(novo.tenantId).toBe(tA);
      await expect(d().create({ data: { ...MODELS[model].create(), tenantId: tB } })).rejects.toThrow(/tenantGuard/);
      const { count } = await d().createMany({ data: [MODELS[model].create()] });
      expect(count).toBe(1);
    });
  });

  it("upsert pelo id do B cria uma linha nova no A em vez de mexer no B", async () => {
    const antes = await linhasDoB(model);
    await asA(async () => {
      const r = await d().upsert({ where: { id: ids[model].B }, create: MODELS[model].create(), update: MODELS[model].update });
      expect(r.tenantId).toBe(tA);
      expect(r.id).not.toBe(ids[model].B);
    });
    expect(await linhasDoB(model)).toEqual(antes);
  });
});

describe("Tenant e relações", () => {
  it("o tenant A só enxerga a si mesmo", async () => {
    await asA(async () => {
      expect((await prisma.tenant.findMany()).map((t) => t.id)).toEqual([tA]);
      await expect(prisma.tenant.findUnique({ where: { id: tB } })).rejects.toThrow(/tenantGuard/);
      await expect(prisma.tenant.update({ where: { id: tB }, data: { name: "x" } })).rejects.toThrow(/tenantGuard/);
    });
  });

  it("filtro de segmento por etiqueta (ClientTag, `some`) só acha clientes do A", async () => {
    // etiqueta própria: os testes acima renomeiam as etiquetas do A
    await withCrossTenantAccess(async () => {
      await prisma.clientTag.create({ data: { tenantId: tA, clientId: ids.client.A, tag: "segmento-x" } });
      await prisma.clientTag.create({ data: { tenantId: tB, clientId: ids.client.B, tag: "segmento-x" } });
    });
    await asA(async () => {
      const r = await prisma.client.findMany({ where: { tags: { some: { tag: { in: ["segmento-x"] } } } }, select: { id: true } });
      expect(r.map((c) => c.id)).toEqual([ids.client.A]);
    });
  });

  it("sem contexto nenhuma query roda", async () => {
    await expect(prisma.client.count()).rejects.toThrow(/sem contexto de tenant/);
  });
});

describe("SQL cru (tenantRaw) no SQLite", () => {
  it('filtra pelo "tenantId" = $1, repete parâmetro e recusa outro tenant', async () => {
    await asA(async () => {
      const rows = await tenantRaw.query<{ n: number }[]>(
        'SELECT COUNT(*) AS n FROM "Notification" n WHERE n."tenantId" = $1 AND n."type" <> $2 AND EXISTS (SELECT 1 FROM "Tenant" t WHERE t."id" = $1)',
        tA,
        "nenhum"
      );
      expect(Number(rows[0].n)).toBe(await prisma.notification.count());
      await expect(tenantRaw.query('SELECT 1 FROM "Notification" WHERE "tenantId" = $1', tB)).rejects.toThrow(/1º parâmetro/);
    });
  });
});

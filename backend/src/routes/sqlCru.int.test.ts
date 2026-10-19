import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { configureDatabase, prisma } from "../config/db";
import { migrationStatements } from "../config/d1Migrations";
import { runWithTenantContextAsync, withCrossTenantAccess } from "../config/tenantGuard";
import { OPPORTUNITY_KEYS } from "../services/opportunities";

/**
 * Fase 4 da migração: todo o SQL cru (dashboard, comércio, ciclos, uso real, limpar base) rodando contra um SQLite de
 * verdade, com as mesmas migrations do D1, pela API inteira (app real, token real). Os números esperados saem dos
 * dados montados aqui; o que interessa é o dialeto (datas em Brasília, listas em JSON, colunas derivadas) e que nenhum
 * endpoint quebre.
 */

process.env.JWT_SECRET ||= randomBytes(32).toString("hex");
process.env.CREDENTIALS_ENCRYPTION_KEY ||= randomBytes(32).toString("base64");

const dbFile = join(tmpdir(), `crm-sqlcru-${randomUUID()}.sqlite`);
let app: Express;
let token = "";
let tenantId = "";
const ids: Record<string, string> = {};

const DIA = 24 * 3600_000;
const agora = Date.now();
const diasAtras = (n: number) => new Date(agora - n * DIA);
const hojeBrt = new Date(agora - 3 * 3600_000); // calendário de Brasília (UTC-3)

const get = (url: string) => request(app).get(url).set("authorization", `Bearer ${token}`);

beforeAll(async () => {
  configureDatabase(() => new PrismaBetterSqlite3({ url: `file:${dbFile}` }));
  app = (await import("../app")).default as Express;
  const { signToken } = await import("../middleware/auth");

  await withCrossTenantAccess(async () => {
    for (const stmt of migrationStatements()) await prisma.$executeRawUnsafe(stmt);
    tenantId = (await prisma.tenant.create({ data: { name: "SQL cru" } })).id;
  });
  await runWithTenantContextAsync(tenantId, async () => {
    const admin = await prisma.user.create({ data: { tenantId, name: "Admin", email: "admin@sqlcru.test", passwordHash: "x", role: "ADMIN" } });
    token = signToken({ id: admin.id, tenantId, role: "ADMIN", email: admin.email });

    const cliente = (nome: string, cidade: string | null, limiteTotal: number, extra: Record<string, unknown> = {}) =>
      prisma.client.create({
        data: {
          tenantId,
          nome,
          cidade,
          limiteTotal,
          valorUtilizado: limiteTotal * 0.6,
          saldoDisponivel: limiteTotal * 0.4,
          percentualUtilizado: limiteTotal ? 60 : 0,
          faixaUso: limiteTotal ? "USO_51_70" : "INDEFINIDO",
          statusConta: "ATIVO",
          autorizacaoComunicacao: true,
          telefone: `+55849${Math.floor(10000000 + Math.random() * 89999999)}`,
          cpfHash: randomUUID(),
          cpfMasked: "***",
          ...extra,
        },
      });
    // aniversário no dia 1 do mês corrente (já passou): idade = ano atual − 1990
    const nascimento = new Date(Date.UTC(1990, hojeBrt.getUTCMonth(), 1));
    ids.jose = (await cliente("José da Silva", "Natal", 1000, { dataNascimento: nascimento, dataUltimaUtilizacao: new Date(agora) })).id;
    ids.ana = (await cliente("Ana Luíza", " Luziânia ", 2000)).id;
    ids.empresa = (await cliente("Empresa", "TOP CONTA LTDA", 500, { encerradoEm: new Date(agora) })).id;
    ids.lojista = (await cliente("Lojista", "Natal", 0)).id;

    const merchant = await prisma.merchant.create({ data: { tenantId, name: "Mercado Bom Preço", nameKey: "mercado bom preco", category: "SUPERMERCADO" } });
    const compra = (clientId: string, tipo: string, valor: number, dias: number, extra: Record<string, unknown> = {}) =>
      prisma.purchase.create({ data: { tenantId, clientId, tipo, valorPrincipal: valor, occurredAt: diasAtras(dias), externalId: randomUUID(), ...extra } });
    await compra(ids.jose, "Débito Pix Cartão", 100, 2, { juros: 10 });
    await compra(ids.jose, "Compra à Vista Cartão Top Convênio", 50, 5, { merchantId: merchant.id, merchantName: merchant.name });
    await compra(ids.ana, "COMPRA A VISTA Cartão Top Convênio", 30, 3, { merchantId: merchant.id, merchantName: merchant.name });
    await compra(ids.ana, "Assinatura AMEF-Gleebem", 20, 1);
    await compra(ids.jose, "Débito Pix Cartão", 70, 40, { juros: 7 });

    await prisma.cicloCidade.create({ data: { tenantId, cidadeKey: "natal", cidade: "Natal", diaAbertura: hojeBrt.getUTCDate() } });
    const { refreshUsageColumns } = await import("../services/usageRefresh");
    const { refreshCicloColumns } = await import("../services/cicloRefresh");
    await refreshUsageColumns(tenantId);
    await refreshCicloColumns(tenantId);
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(dbFile, { force: true });
});

describe("colunas derivadas", () => {
  it("cidadeKey, nomeBusca e usoTipo calculados em JS na gravação", async () => {
    const c = await runWithTenantContextAsync(tenantId, () =>
      prisma.client.findMany({ select: { nome: true, cidadeKey: true, nomeBusca: true }, orderBy: { nome: "asc" } })
    );
    expect(c).toEqual([
      { nome: "Ana Luíza", cidadeKey: "luziânia", nomeBusca: "ana luiza" },
      { nome: "Empresa", cidadeKey: "__SEM_CIDADE__", nomeBusca: "empresa" },
      { nome: "José da Silva", cidadeKey: "natal", nomeBusca: "jose da silva" },
      { nome: "Lojista", cidadeKey: "natal", nomeBusca: "lojista" },
    ]);
    const tipos = await runWithTenantContextAsync(tenantId, () => prisma.purchase.groupBy({ by: ["usoTipo"], _count: true }));
    expect(Object.fromEntries(tipos.map((t) => [t.usoTipo, t._count]))).toEqual({ ANTECIPACAO: 2, COMPRA: 2, ASSINATURA: 1 });
  });

  it("atualizar a cidade recalcula a chave; gravar a chave à mão é recusado", async () => {
    await runWithTenantContextAsync(tenantId, async () => {
      await prisma.client.update({ where: { id: ids.lojista }, data: { cidade: "Lagarto" } });
      expect((await prisma.client.findUnique({ where: { id: ids.lojista }, select: { cidadeKey: true } }))?.cidadeKey).toBe("lagarto");
      await prisma.client.update({ where: { id: ids.lojista }, data: { cidade: { set: "Natal" } } });
      expect((await prisma.client.findUnique({ where: { id: ids.lojista }, select: { cidadeKey: true } }))?.cidadeKey).toBe("natal");
      await expect(prisma.client.update({ where: { id: ids.lojista }, data: { cidadeKey: "x" } })).rejects.toThrow(/derivedColumns/);
    });
  });

  it("busca de segmento por nome ignora acento e caixa", async () => {
    const r = await request(app).post("/api/segments/preview").set("authorization", `Bearer ${token}`).send({ search: "LUÍZA" });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(1);
  });
});

it("uso real por cliente (usageRefresh) e dia de abertura do ciclo (cicloRefresh)", async () => {
  const c = await runWithTenantContextAsync(tenantId, () =>
    prisma.client.findMany({ select: { nome: true, usosTotal: true, usosUltimos90d: true, ultimoUsoReal: true, diaCicloAbertura: true }, orderBy: { nome: "asc" } })
  );
  const por = Object.fromEntries(c.map((x) => [x.nome, x]));
  expect(por["José da Silva"]).toMatchObject({ usosTotal: 3, usosUltimos90d: 3, diaCicloAbertura: hojeBrt.getUTCDate() });
  expect(por["José da Silva"].ultimoUsoReal?.getTime()).toBe(diasAtras(2).getTime());
  expect(por["Ana Luíza"]).toMatchObject({ usosTotal: 1, diaCicloAbertura: null });
  expect(por["Empresa"]).toMatchObject({ usosTotal: 0, ultimoUsoReal: null });
});

describe("dashboard", () => {
  it("uso no período: só antecipação e compra à vista, por dia de Brasília e por cidade", async () => {
    const r = await get("/api/dashboard/uso-periodo?days=30");
    expect(r.status).toBe(200);
    expect(r.body.totais).toMatchObject({ clientes: 2, usos: 3, valorMovimentado: 180, lucroJuros: 10, antecipacoes: { qtd: 1, valor: 100 }, comprasAVista: { qtd: 2, valor: 80 } });
    expect(r.body.serie.reduce((a: number, d: any) => a + d.usos, 0)).toBe(3);
    expect(r.body.adesao).toMatchObject({ base: 3, usaram: 2 });
    const cidades = Object.fromEntries(r.body.cidades.map((c: any) => [c.cidade, c]));
    expect(cidades["Natal"]).toMatchObject({ base: 1, usaram: 1, usos: 2 });
    expect(cidades[" Luziânia "]).toMatchObject({ base: 1, usaram: 1, usos: 1 });
    expect(r.body.extrato.ultimo).toBe(new Date(diasAtras(2).getTime() - 3 * 3600_000).toISOString().slice(0, 10));
  });

  it("uso no período com filtro de cidade", async () => {
    const r = await get("/api/dashboard/uso-periodo?days=30&cidade=Natal");
    expect(r.status).toBe(200);
    expect(r.body.totais).toMatchObject({ clientes: 1, usos: 2 });
  });

  it("aniversariantes, faixa etária, uso e encerramento no mês", async () => {
    const eng = await get("/api/dashboard/engajamento");
    expect(eng.status).toBe(200);
    expect(eng.body.aniversariantes.total).toBe(1);
    expect(eng.body.aniversariantes.itens[0]).toMatchObject({ id: ids.jose, dia: 1 });

    const perfil = await get("/api/dashboard/perfil");
    expect(perfil.status).toBe(200);
    const idade = hojeBrt.getUTCFullYear() - 1990;
    const faixa = idade < 36 ? "26-35" : idade < 46 ? "36-45" : "46-55";
    expect(perfil.body.faixaEtaria).toContainEqual({ faixa, count: 1 });

    const mensal = await get("/api/dashboard/uso-mensal");
    expect(mensal.status).toBe(200);
    expect(mensal.body.meses.at(-1).usados).toBe(1);
    const enc = await get("/api/dashboard/encerramentos");
    expect(enc.status).toBe(200);
    expect(enc.body.meses.at(-1).encerrados).toBe(1);
  });

  it("evolução semanal e mensal: início do período em ISO", async () => {
    for (const g of ["weekly", "monthly"]) {
      const r = await get(`/api/dashboard/evolucao?granularity=${g}`);
      expect(r.status).toBe(200);
      expect(r.body.reduce((a: number, x: any) => a + x.total, 0)).toBe(4);
      for (const x of r.body) expect(x.periodo).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    }
    const semana = (await get("/api/dashboard/evolucao")).body[0].periodo;
    expect(new Date(semana).getUTCDay()).toBe(1); // segunda-feira
  });

  it("perfis de renda (PF pelo limite) e detalhe do PF1 com uso do extrato", async () => {
    const r = await get("/api/dashboard/perfis-renda");
    expect(r.status).toBe(200);
    const total = Object.fromEntries(r.body.perfis.map((p: any) => [p.perfil, p.total]));
    expect(total).toMatchObject({ PF1: 2, PF2: 1, PF3: 0, PF4: 0 });
    expect(r.body.semLimite).toBe(1);

    const pf1 = await get("/api/dashboard/perfis-renda/PF1");
    expect(pf1.status).toBe(200);
    expect(pf1.body.uso).toMatchObject({ clientes: 1, transacoes: 3, valorMovimentado: 220 });
    const pf1Datas = await get(`/api/dashboard/perfis-renda/PF1?de=${diasAtras(10).toISOString().slice(0, 10)}`);
    expect(pf1Datas.body.uso).toMatchObject({ transacoes: 2 });
  });

  it("adesão por ciclo, frescor, oportunidades e todos os públicos", async () => {
    const ad = await get("/api/dashboard/adesao-ciclo");
    expect(ad.status).toBe(200);
    expect(ad.body.cidades).toHaveLength(1);
    expect((await get("/api/dashboard/frescor")).body.status).toBe("OK");

    const op = await get("/api/dashboard/oportunidades");
    expect(op.status).toBe(200);
    for (const tipo of OPPORTUNITY_KEYS) {
      const a = await get(`/api/dashboard/audiencia?tipo=${tipo}`);
      expect([tipo, a.status]).toEqual([tipo, 200]);
    }
    const aniversario = await get("/api/dashboard/audiencia?tipo=aniversariantes");
    expect(aniversario.body.clientIds).toEqual([ids.jose]);
    const compradores = await get("/api/dashboard/audiencia?tipo=comercio_1vez");
    expect([...compradores.body.clientIds].sort()).toEqual([ids.ana, ids.jose].sort());
  });

  it("visão geral e resumo respondem", async () => {
    for (const url of ["/api/dashboard/overview", "/api/dashboard/overview?cidade=Natal", "/api/dashboard/summary"]) {
      expect([url, (await get(url)).status]).toEqual([url, 200]);
    }
  });
});

describe("comércio credenciado", () => {
  it("categorias, cidades (chave com acento) e lojistas com busca sem acento", async () => {
    const cat = await get("/api/purchases/categories");
    expect(cat.status).toBe(200);
    expect(cat.body.categorias).toEqual([expect.objectContaining({ category: "SUPERMERCADO", clientes: 2, compras: 2, valor: 80, lojistas: 1 })]);
    expect(cat.body.totais).toMatchObject({ clientes: 2, compras: 2, valor: 80 });

    const cid = await get("/api/purchases/cidades");
    expect(cid.body.map((c: any) => c.chave).sort()).toEqual(["luziânia", "natal"]);

    const soNatal = await get(`/api/purchases/categories?cidades=${encodeURIComponent("natal")}`);
    expect(soNatal.body.totais).toMatchObject({ clientes: 1, compras: 1 });

    const lojistas = await get(`/api/purchases/merchants?search=${encodeURIComponent("BOM PREÇO")}&cidades=${encodeURIComponent("luziânia")}`);
    expect(lojistas.status).toBe(200);
    expect(lojistas.body).toEqual([expect.objectContaining({ name: "Mercado Bom Preço", compras: 1, clientes: 1 })]);
  });

  it("público por categoria e frequência", async () => {
    const r = await get("/api/purchases/audiencia?categorias=SUPERMERCADO&minCompras=1");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 2, porFrequencia: [2, 0, 0] });
  });
});

describe("ciclos", () => {
  it("próximos, audiência e uso por dia do ciclo", async () => {
    const prox = await get("/api/ciclos/proximos");
    expect(prox.status).toBe(200);
    const aud = await get("/api/ciclos/audiencia?cidadeKey=natal");
    expect(aud.status).toBe(200);
    expect(aud.body.clientIds).toEqual([ids.jose]);
    const uso = await get("/api/ciclos/uso-por-dia");
    expect(uso.status).toBe(200);
    expect(uso.body.cidades.map((c: any) => [c.cidadeKey, c.usos, c.clientes])).toEqual([
      [null, 3, 1], // total
      ["natal", 3, 1],
    ]);
  });
});

describe("retenção e limpar base", () => {
  it("anonimizar o titular leva a data das compras ao 1º dia do mês", async () => {
    const { anonymizeClient } = await import("../services/retention");
    await runWithTenantContextAsync(tenantId, async () => {
      await anonymizeClient(prisma, tenantId, ids.ana, { motivo: "teste" } as any).catch(() => undefined);
      const compras = await prisma.purchase.findMany({ where: { clientId: ids.ana }, select: { occurredAt: true, externalId: true } });
      for (const c of compras) {
        expect(c.externalId.startsWith("anon-")).toBe(true);
        expect(c.occurredAt.toISOString()).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
      }
    });
  });

  it("limpar base apaga clientes, compras e etiquetas do tenant", async () => {
    await runWithTenantContextAsync(tenantId, () => prisma.clientTag.create({ data: { tenantId, clientId: ids.jose, tag: "vip" } }));
    const r = await request(app).post("/api/clients/purge").set("authorization", `Bearer ${token}`).send({ confirm: "LIMPAR BASE" });
    expect(r.status).toBe(200);
    expect(r.body.clients).toBe(4);
    const restantes = await runWithTenantContextAsync(tenantId, () =>
      Promise.all([prisma.client.count(), prisma.purchase.count(), prisma.clientTag.count()])
    );
    expect(restantes).toEqual([0, 0, 0]);
  });
});

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { d1LikeAdapter } from "../config/d1Like";
import { configureDatabase, prisma } from "../config/db";
import { migrationStatements } from "../config/d1Migrations";
import { runWithTenantContextAsync, withCrossTenantAccess } from "../config/tenantGuard";

/**
 * Quantas consultas ao banco cada lote de importação faz. No Worker cada consulta é uma chamada ao D1
 * (subrequisição para serviço interno): o limite por invocação é 1.000 no plano grátis e 10.000 no pago, e com
 * o D1 a ~150 ms do Worker (sem Smart Placement) cada consulta em sequência custa esse tempo. O teste conta as
 * consultas de um lote do tamanho que a tela manda (`BATCH_SIZE` de `frontend/src/pages/Imports.tsx`) e falha se
 * passar do orçamento.
 */

process.env.JWT_SECRET ||= randomBytes(32).toString("hex");
process.env.CREDENTIALS_ENCRYPTION_KEY ||= randomBytes(32).toString("base64");

const LOTE = Number(process.env.LOTE || 400); // = BATCH_SIZE da tela de importações
const LIMITE_D1_GRATIS = 1000;

const dbFile = join(tmpdir(), `crm-import-q-${randomUUID()}.sqlite`);
let consultas = 0;
const sqls: string[] = [];
let app: Express;
let token = "";
let tenantId = "";

/** Fábrica do adapter que conta toda consulta (fora e dentro de transação). */
function contando(factory: ReturnType<typeof d1LikeAdapter>) {
  const conta = <T extends object>(alvo: T): T =>
    new Proxy(alvo, {
      get(t, p, r) {
        const v = Reflect.get(t, p, r);
        if (typeof v !== "function") return v;
        if (p === "queryRaw" || p === "executeRaw") return (...a: unknown[]) => (consultas++, sqls.push(String((a[0] as { sql?: string })?.sql).slice(0, 160)), v.apply(t, a));
        if (p === "startTransaction") return async (...a: unknown[]) => conta(await v.apply(t, a));
        return v.bind(t);
      },
    });
  return new Proxy(factory, {
    get(t, p, r) {
      if (p === "connect") return async () => conta(await t.connect());
      const v = Reflect.get(t, p, r);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

/** CPF válido (dígitos verificadores) a partir de um número. */
function cpf(n: number): string {
  const base = String(100000000 + n).slice(-9).split("").map(Number);
  const dv = (ds: number[]) => {
    const s = ds.reduce((a, d, i) => a + d * (ds.length + 1 - i), 0) % 11;
    return s < 2 ? 0 : 11 - s;
  };
  const d1 = dv(base);
  const d2 = dv([...base, d1]);
  return [...base, d1, d2].join("");
}
const telefone = (n: number) => `849${String(80000000 + n)}`;

async function medir(url: string, body: object): Promise<number> {
  consultas = 0;
  const r = await request(app).post(url).set("authorization", `Bearer ${token}`).send(body);
  expect([url, r.status, r.body.errorCount ?? 0]).toEqual([url, 200, 0]);
  return consultas;
}

const medidas: Record<string, number> = {};

beforeAll(async () => {
  configureDatabase(() => contando(d1LikeAdapter(`file:${dbFile}`)) as never);
  app = (await import("../app")).default as Express;
  const { signToken } = await import("../middleware/auth");
  await withCrossTenantAccess(async () => {
    for (const stmt of migrationStatements()) await prisma.$executeRawUnsafe(stmt);
    tenantId = (await prisma.tenant.create({ data: { name: "Importação" } })).id;
  });
  await runWithTenantContextAsync(tenantId, async () => {
    const admin = await prisma.user.create({ data: { tenantId, name: "Admin", email: "admin@import.test", passwordHash: "x", role: "ADMIN" } });
    token = signToken({ id: admin.id, tenantId, role: "ADMIN", email: admin.email });
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(dbFile, { force: true });
  console.log(`[importação] consultas por lote de ${LOTE} linhas:`, medidas);
  if (process.env.LOG_SQL) console.log(sqls.join("\n"));
});

const cartoes = (desloca: number, limite: number) =>
  Array.from({ length: LOTE }, (_, i) => ({
    documento: cpf(i),
    nome: `Cliente ${i}`,
    telefone: telefone(i + desloca),
    cidade: i % 2 ? "Natal" : "Lagarto",
    id_cartao: `C${i}`,
    limite: limite + (i % 7),
    saldo_disponivel: limite / 2,
    status_cartao: "ATIVOU_CARTAO",
  }));
const presenca = { limite: true, saldo: true, utilizado: false, status: true };

describe(`lote de ${LOTE} linhas`, () => {
  it("Cartões e contas: clientes novos", async () => {
    medidas.cartoesNovos = await medir("/api/imports/cartoes", { rows: cartoes(0, 1000), camposPresentes: presenca, loteId: randomUUID() });
    expect(medidas.cartoesNovos).toBeLessThan(LIMITE_D1_GRATIS);
  });

  it("Cartões e contas: os mesmos clientes com limite novo", async () => {
    medidas.cartoesAtualizados = await medir("/api/imports/cartoes", { rows: cartoes(0, 1500), camposPresentes: presenca, loteId: randomUUID() });
    expect(medidas.cartoesAtualizados).toBeLessThan(LIMITE_D1_GRATIS);
  });

  it("Conferir impacto (preview)", async () => {
    consultas = 0;
    const r = await request(app).post("/api/imports/cartoes/preview").set("authorization", `Bearer ${token}`).send({ rows: cartoes(0, 2000), camposPresentes: presenca });
    expect(r.status).toBe(200);
    medidas.preview = consultas;
    expect(medidas.preview).toBeLessThan(LIMITE_D1_GRATIS);
  });

  it("CSV genérico: clientes novos", async () => {
    const rows = Array.from({ length: LOTE }, (_, i) => ({
      id_cliente: `G${i}`,
      nome: `Genérico ${i}`,
      telefone: telefone(5000 + i),
      cpf: cpf(5000 + i),
      cidade: "Natal",
      limite_total: 800,
      valor_utilizado: 100,
      autorizacao_comunicacao: "sim",
    }));
    medidas.csvNovos = await medir("/api/imports/csv", { rows, loteId: randomUUID() });
    expect(medidas.csvNovos).toBeLessThan(LIMITE_D1_GRATIS);
  });

  it("CSV genérico: CPF repetido no mesmo lote atualiza o cliente criado pela linha anterior", async () => {
    const linha = { id_cliente: "R1", nome: "Repetido", telefone: telefone(9000), cpf: cpf(9000), limite_total: 500 };
    const r = await request(app)
      .post("/api/imports/csv")
      .set("authorization", `Bearer ${token}`)
      .send({ rows: [linha, { ...linha, nome: "Repetido Atualizado", telefone: telefone(9001) }, { ...linha, cpf: cpf(9002), nome: "Mesmo telefone" }] });
    expect(r.status).toBe(200);
    expect([r.body.addedCount, r.body.updatedCount, r.body.errorCount]).toEqual([2, 1, 0]);
    const clientes = await runWithTenantContextAsync(tenantId, () =>
      prisma.client.findMany({ where: { externalId: "R1" }, select: { nome: true, telefone: true } })
    );
    // 2ª linha: mesmo CPF → atualiza (e troca o telefone); 3ª: CPF novo e telefone que já não é de ninguém → cria
    expect(clientes.map((c) => c.nome).sort()).toEqual(["Mesmo telefone", "Repetido Atualizado"]);
  });

  it("Compras", async () => {
    const rows = Array.from({ length: LOTE }, (_, i) => ({
      id_transacao: `T${i}`,
      data: "2026-10-10 10:00:00",
      documento: cpf(i % 200),
      descricao: i % 2 ? "Débito Pix Cartão" : "Compra à Vista Cartão Top Convênio",
      lojista: i % 2 ? "" : `Loja ${i % 20}`,
      valor_principal: "100.00",
      juros: i % 2 ? "10.00" : "0",
    }));
    consultas = 0;
    const r = await request(app).post("/api/purchases/import").set("authorization", `Bearer ${token}`).send({ rows, loteId: randomUUID() });
    expect(r.status).toBe(200);
    expect(r.body.importedCount).toBe(LOTE);
    medidas.compras = consultas;
    expect(medidas.compras).toBeLessThan(LIMITE_D1_GRATIS);
  });
});

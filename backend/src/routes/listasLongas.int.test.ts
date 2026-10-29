import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { configureDatabase, prisma } from "../config/db";
import { d1LikeAdapter } from "../config/d1Like";
import { migrationStatements } from "../config/d1Migrations";
import { runWithTenantContextAsync, withCrossTenantAccess } from "../config/tenantGuard";

/**
 * Públicos e relatórios com listas maiores que o limite de parâmetros do D1 (~98 por consulta), pela API inteira:
 * cada rota aqui quebrava com P2029 com mais de ~90 clientes (lista vinda do dashboard/comércio/ciclo, campanha
 * por planilha, relatório da campanha). Ver src/config/d1Partes.ts.
 */

process.env.JWT_SECRET ||= randomBytes(32).toString("hex");
process.env.CREDENTIALS_ENCRYPTION_KEY ||= randomBytes(32).toString("base64");

const N = 150;
const dbFile = join(tmpdir(), `crm-listas-${randomUUID()}.sqlite`);
let app: Express;
let token = "";
let tenantId = "";
let templateId = "";
let ids: string[] = [];
const telefone = (i: number) => `+5584988${String(100000 + i)}`;

const api = (metodo: "get" | "post", url: string, body?: object) => {
  const r = request(app)[metodo](url).set("authorization", `Bearer ${token}`);
  return body ? r.send(body) : r;
};

beforeAll(async () => {
  configureDatabase(() => d1LikeAdapter(`file:${dbFile}`));
  app = (await import("../app")).default as Express;
  const { signToken } = await import("../middleware/auth");
  await withCrossTenantAccess(async () => {
    for (const stmt of migrationStatements()) await prisma.$executeRawUnsafe(stmt);
    tenantId = (await prisma.tenant.create({ data: { name: "Listas", baseLegalMarketing: "CONSENTIMENTO" } })).id;
  });
  await runWithTenantContextAsync(tenantId, async () => {
    const admin = await prisma.user.create({ data: { tenantId, name: "Admin", email: "admin@listas.test", passwordHash: "x", role: "ADMIN" } });
    token = signToken({ id: admin.id, tenantId, role: "ADMIN", email: admin.email });
    templateId = (
      await prisma.messageTemplate.create({
        data: { tenantId, channel: "WHATSAPP", name: "Oferta", body: "Olá {{nome}}, seu saldo está disponível.", status: "APROVADO", metaStatus: "APPROVED", category: "UTILITY" },
      })
    ).id;
    const merchant = await prisma.merchant.create({ data: { tenantId, name: "Mercado", nameKey: "mercado", category: "SUPERMERCADO" } });
    for (let i = 0; i < N; i++) {
      const c = await prisma.client.create({
        data: {
          tenantId,
          nome: `Cliente ${i}`,
          telefone: telefone(i),
          cpfHash: `h${i}`,
          cpfMasked: "***",
          cidade: "Natal",
          limiteTotal: 1000,
          saldoDisponivel: 500,
          valorUtilizado: 500,
          statusConta: "ATIVO",
          autorizacaoComunicacao: true,
        },
      });
      ids.push(c.id);
      await prisma.purchase.create({
        data: { tenantId, clientId: c.id, tipo: "Compra à Vista Cartão", valorPrincipal: 50, occurredAt: new Date(Date.now() - 2 * 86400_000), externalId: `p${i}`, merchantId: merchant.id },
      });
    }
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(dbFile, { force: true });
});

it(`público de oportunidade e de comércio com ${N} clientes: autorizados contados em pedaços`, async () => {
  const op = await api("get", "/api/dashboard/audiencia?tipo=comercio_1vez");
  expect([op.status, op.body.total, op.body.autorizados]).toEqual([200, N, N]);
  const com = await api("get", "/api/purchases/audiencia?categorias=SUPERMERCADO");
  expect([com.status, com.body.total, com.body.autorizados]).toEqual([200, N, N]);
});

it("assistente com lista de clientes: elegíveis e dedupe", async () => {
  const r = await api("post", "/api/campaigns/wizard/validar", { templateId, audience: { tipo: "lista", clientIds: ids } });
  expect(r.status).toBe(200);
  expect(r.body.checks?.find((c: any) => c.id === "publico")?.titulo ?? JSON.stringify(r.body)).toContain(`${N} clientes elegíveis`);
});

it("campanha por lista: estimativa, fila e relatório", async () => {
  const c = await api("post", "/api/campaigns", { name: "Lista", channel: "WHATSAPP", templateId, adHocFilters: { clientIds: ids } });
  expect([c.status, c.body.audienceCount]).toEqual([201, N]);
  const fila = await api("post", `/api/campaigns/${c.body.id}/schedule`);
  expect(fila.status).toBe(200);
  const enviadoEm = new Date(Date.now() - 5 * 86400_000);
  await runWithTenantContextAsync(tenantId, async () => {
    expect(await prisma.messageEvent.count({ where: { campaignId: c.body.id } })).toBe(N);
    await prisma.messageEvent.updateMany({ where: { campaignId: c.body.id }, data: { status: "ENVIADO", sentAt: enviadoEm } });
  });
  const rel = await api("get", `/api/campaigns/${c.body.id}/report`);
  expect(rel.status).toBe(200);
});

it("campanha por planilha: prévia, criação (fila dos destinatários) e destinatários", async () => {
  const rows = Array.from({ length: N }, (_, i) => ({ nome: `Cliente ${i}`, telefone: telefone(i) }));
  const prev = await api("post", "/api/campaigns/manual/preview", { templateId, rows });
  expect([prev.status, prev.body.enviar, prev.body.daBase]).toEqual([200, N, N]);
  const criada = await api("post", "/api/campaigns/manual", { name: "Planilha", templateId, rows, consentimento: true });
  expect(criada.status).toBeLessThan(300);
  const id = criada.body.id ?? criada.body.campaign?.id;
  const dest = await api("get", `/api/campaigns/${id}/destinatarios`);
  expect(dest.status).toBe(200);
});

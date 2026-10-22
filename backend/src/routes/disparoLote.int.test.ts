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

/** Disparo em lote (25 mensagens por chamada, como a tela do assistente) sobre SQLite com os limites do D1. */

process.env.JWT_SECRET ||= randomBytes(32).toString("hex");
process.env.CREDENTIALS_ENCRYPTION_KEY ||= randomBytes(32).toString("base64");
process.env.MESSAGING_MODE = "mock";

const N = 195;
const dbFile = join(tmpdir(), `crm-disparo-${randomUUID()}.sqlite`);
let app: Express;
let token = "";
let campaignId = "";

beforeAll(async () => {
  configureDatabase(() => d1LikeAdapter(`file:${dbFile}`));
  app = (await import("../app")).default as Express;
  const { signToken } = await import("../middleware/auth");
  let tenantId = "";
  await withCrossTenantAccess(async () => {
    for (const stmt of migrationStatements()) await prisma.$executeRawUnsafe(stmt);
    tenantId = (await prisma.tenant.create({ data: { name: "Disparo", baseLegalMarketing: "CONSENTIMENTO" } })).id;
  });
  await runWithTenantContextAsync(tenantId, async () => {
    const admin = await prisma.user.create({ data: { tenantId, name: "Admin", email: "admin@disparo.test", passwordHash: "x", role: "ADMIN" } });
    token = signToken({ id: admin.id, tenantId, role: "ADMIN", email: admin.email });
    const campaign = await prisma.campaign.create({
      data: { tenantId, name: "limite", channel: "WHATSAPP", messageTemplate: "Olá {{nome}}, seu limite {{limite_disponivel}}.", status: "AGENDADA", audienceCount: N, baseLegal: "CONSENTIMENTO" },
    });
    campaignId = campaign.id;
    for (let i = 0; i < N; i++) {
      const c = await prisma.client.create({
        data: { tenantId, nome: `Cliente ${i}`, telefone: `+5579988${String(100000 + i)}`, cpfHash: `h${i}`, cpfMasked: "***", cidade: "Luziânia", limiteTotal: 1000, saldoDisponivel: 500, valorUtilizado: 500, statusConta: "ATIVO", autorizacaoComunicacao: true },
      });
      await prisma.messageEvent.create({ data: { tenantId, campaignId, clientId: c.id, channel: "WHATSAPP", status: "FILA" } });
    }
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(dbFile, { force: true });
});

it("dispara os 195 em lotes de 25 sem erro", async () => {
  let restante = N;
  for (let volta = 0; volta < 12 && restante > 0; volta++) {
    const r = await request(app).post(`/api/campaigns/${campaignId}/dispatch`).set("authorization", `Bearer ${token}`).send({ limit: 25 });
    if (r.status !== 200) throw new Error(`volta ${volta}: ${r.status} ${JSON.stringify(r.body)}`);
    restante = r.body.remaining;
  }
  expect(restante).toBe(0);
});

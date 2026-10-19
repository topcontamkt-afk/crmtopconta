// Spike da Fase 0: Express + Prisma 7 + D1 rodando no workerd (local). Descartável.
// Cada rota responde uma pergunta do relatório go/no-go (docs/infra/cloudflare-fase0.md).
import express from "express";
import { httpServerHandler } from "cloudflare:node";
import { env } from "cloudflare:workers";
import { PrismaD1 } from "@prisma/adapter-d1";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { authenticator } from "otplib";
import QRCode from "qrcode";
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { PrismaClient } from "./generated/prisma/client";

let client: PrismaClient | undefined;
const db = () => (client ??= new PrismaClient({ adapter: new PrismaD1((env as any).DB) }));

const app = express();
app.use(express.json({ limit: "5mb" }));

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Bibliotecas de autenticação e o crypto do Node (nodejs_compat).
app.post("/api/spike/bcrypt", async (req, res) => {
  // ?modo=sync usa hashSync/compareSync; o padrão é a versão assíncrona usada no backend
  if (req.query.modo === "sync") {
    const hash = bcrypt.hashSync("mudar123", 10);
    return res.json({ bcryptSync: bcrypt.compareSync("mudar123", hash) });
  }
  const hash = await bcrypt.hash("mudar123", 10);
  res.json({ bcryptAsync: await bcrypt.compare("mudar123", hash) });
});

// Uma rota por biblioteca, para achar a que trava.
const libs: Record<string, () => Promise<unknown> | unknown> = {
  jwt: () => {
    const token = jwt.sign({ sub: "u1", tenantId: "t1" }, "segredo-de-teste", { expiresIn: "12h" });
    return (jwt.verify(token, "segredo-de-teste") as any).tenantId === "t1";
  },
  otp: () => {
    const secret = authenticator.generateSecret();
    return authenticator.check(authenticator.generate(secret), secret);
  },
  qrcode: async () => (await QRCode.toDataURL("otpauth://totp/CRM:a@b.c?secret=JBSWY3DPEHPK3PXP")).startsWith("data:image/png"),
  qrcodeSvg: async () => {
    const svg = await QRCode.toString("otpauth://totp/CRM:a@b.c?secret=JBSWY3DPEHPK3PXP", { type: "svg" });
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`.length > 100;
  },
  aesGcm: () => {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([c.update("credencial", "utf8"), c.final()]);
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAuthTag(c.getAuthTag());
    return Buffer.concat([d.update(enc), d.final()]).toString("utf8") === "credencial";
  },
  hmac: () => timingSafeEqual(createHmac("sha256", "s").update("1").digest(), createHmac("sha256", "s").update("1").digest()),
};
app.post("/api/spike/lib/:nome", async (req, res) => {
  const fn = libs[req.params.nome];
  if (!fn) return res.status(404).json({ erro: "biblioteca desconhecida" });
  res.json({ [req.params.nome]: await fn() });
});

// Comportamento do Prisma 7 + D1 que o plano precisa confirmar.
app.post("/api/spike/db", async (_req, res) => {
  const p = db();
  const out: Record<string, unknown> = {};
  const [ta, tb] = await Promise.all([p.tenant.create({ data: { name: "A" } }), p.tenant.create({ data: { name: "B" } })]);

  const cli = await p.client.create({
    data: { tenantId: ta.id, nome: "Maria", telefone: "+5579999990000", cpfHash: "h-maria", cpfMasked: "***", limiteTotal: 1234.56, tags: ["vip"] },
  });
  // 1. filtro extra no where do findUnique (base da injeção de tenantId)
  out.findUniqueOutroTenant = await p.client.findUnique({ where: { id: cli.id, tenantId: tb.id } });
  out.findUniqueMesmoTenant = !!(await p.client.findUnique({ where: { id: cli.id, tenantId: ta.id } }));
  // 2. Decimal e Json
  out.decimal = String(cli.limiteTotal);
  out.json = cli.tags;
  // 3. createMany com muitas colunas × linhas (limite de 100 parâmetros por query no D1)
  const rows = Array.from({ length: 300 }, (_, i) => ({
    tenantId: ta.id, nome: `C${i}`, telefone: `+55799${String(i).padStart(8, "0")}`, cpfHash: `h${i}`, cpfMasked: "***",
  }));
  try {
    out.createMany300 = (await p.client.createMany({ data: rows })).count;
  } catch (e: any) {
    out.createMany300 = `ERRO: ${e?.message?.slice(0, 200)}`;
  }
  // 4. lista grande em `in:`
  const ids = (await p.client.findMany({ where: { tenantId: ta.id }, select: { id: true } })).map((x) => x.id);
  const fake = Array.from({ length: 2000 }, (_, i) => ids[i] ?? `x-${i}`);
  try {
    out.findManyIn2000 = (await p.client.findMany({ where: { id: { in: fake } }, select: { id: true } })).length;
  } catch (e: any) {
    out.findManyIn2000 = `ERRO: ${e?.message?.slice(0, 200)}`;
  }
  // 5. formato em que o DateTime fica gravado (decide os fragmentos de SQL cru)
  out.dateTimeNoBanco = await p.$queryRawUnsafe(`SELECT typeof("createdAt") AS tipo, "createdAt" AS valor FROM "Client" LIMIT 1`);
  // 6. upsert por unique composto (padrão das importações)
  const up = await p.client.upsert({
    where: { tenantId_cpfHash: { tenantId: ta.id, cpfHash: "h-maria" } },
    update: { nome: "Maria Atualizada" },
    create: { tenantId: ta.id, nome: "x", telefone: "x", cpfHash: "h-maria", cpfMasked: "***" },
  });
  out.upsertComposto = up.nome;
  // 7. $transaction interativa (o D1 não tem; o que acontece?)
  try {
    await p.$transaction(async (tx) => {
      await tx.tenant.create({ data: { name: "Dentro da transação" } });
      throw new Error("rollback proposital");
    });
  } catch (e: any) {
    out.transacaoErro = e?.message?.slice(0, 160);
  }
  out.transacaoDesfez = (await p.tenant.count({ where: { name: "Dentro da transação" } })) === 0;
  res.json(out);
});

app.listen(3000);
const express_ = httpServerHandler({ port: 3000 });

// Um Worker com três entradas: rota própria antes do Express (ponte de voz), Express e cron.
export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/api/spike/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("use websocket", { status: 426 });
      const pair = new WebSocketPair();
      const [cliente, servidor] = Object.values(pair);
      servidor.accept();
      servidor.addEventListener("message", (ev) => servidor.send(`eco:${ev.data}`));
      return new Response(null, { status: 101, webSocket: cliente });
    }
    return (express_ as any).fetch(request, env, ctx);
  },
  async scheduled(controller: ScheduledController) {
    await db().tenant.create({ data: { name: `cron ${controller.cron}` } });
  },
};

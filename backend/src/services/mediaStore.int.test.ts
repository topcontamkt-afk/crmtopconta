import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { configureDatabase, prisma } from "../config/db";
import { migrationStatements } from "../config/d1Migrations";
import { runWithTenantContextAsync, withCrossTenantAccess } from "../config/tenantGuard";
import {
  configureMediaStore,
  deleteMessageMedia,
  deleteTemplateMedia,
  loadMessageMedia,
  loadTemplateMedia,
  memoryMediaStore,
  saveMessageMedia,
  saveTemplateMedia,
} from "./mediaStore";

/** Mídia no R2 (aqui, em memória) com os metadados num SQLite de verdade (mesmas migrations do D1). */

const dbFile = join(tmpdir(), `crm-midia-${randomUUID()}.sqlite`);
const store = memoryMediaStore();
let tA = "";
let tB = "";
let templateA = "";
const bytes = (s: string) => new Uint8Array(Buffer.from(s));

beforeAll(async () => {
  configureDatabase(() => new PrismaBetterSqlite3({ url: `file:${dbFile}` }));
  configureMediaStore(store);
  await withCrossTenantAccess(async () => {
    for (const stmt of migrationStatements()) await prisma.$executeRawUnsafe(stmt);
    tA = (await prisma.tenant.create({ data: { name: "A" } })).id;
    tB = (await prisma.tenant.create({ data: { name: "B" } })).id;
    templateA = (await prisma.messageTemplate.create({ data: { tenantId: tA, name: "oferta", channel: "WHATSAPP", body: "oi" } })).id;
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(dbFile, { force: true });
});

it("mídia de mensagem: arquivo no R2 com chave do tenant, só o tenant dono lê", async () => {
  await runWithTenantContextAsync(tA, () => saveMessageMedia(prisma, tA, "msg-1", { mime: "image/png", data: bytes("png") }));
  expect(store.keys()).toContain(`t/${tA}/wa/msg-1`);

  const lida = await runWithTenantContextAsync(tA, () => loadMessageMedia(prisma, tA, "msg-1"));
  expect(lida?.data.toString()).toBe("png");
  // o B não chega à linha (guard) nem pedindo o tenant A explicitamente
  await expect(runWithTenantContextAsync(tB, () => loadMessageMedia(prisma, tB, "msg-1"))).resolves.toBeNull();
  await expect(runWithTenantContextAsync(tB, () => loadMessageMedia(prisma, tA, "msg-1"))).rejects.toThrow(/tenantGuard/);

  // gravar de novo a mesma mensagem (outra requisição) não é erro
  await runWithTenantContextAsync(tA, () => saveMessageMedia(prisma, tA, "msg-1", { mime: "image/png", data: bytes("png") }));
});

it("apagar: se o R2 falha, as linhas ficam (a retenção tenta de novo); depois sai tudo", async () => {
  await runWithTenantContextAsync(tA, () => saveMessageMedia(prisma, tA, "msg-2", { mime: "audio/ogg", data: bytes("ogg") }));
  const original = store.delete;
  store.delete = async () => {
    throw new Error("R2 fora");
  };
  await expect(runWithTenantContextAsync(tA, () => deleteMessageMedia(prisma, { tenantId: tA, messageId: { in: ["msg-1", "msg-2"] } }))).rejects.toThrow("R2 fora");
  expect(await runWithTenantContextAsync(tA, () => prisma.waMediaBlob.count())).toBe(2);
  store.delete = original;

  await expect(runWithTenantContextAsync(tA, () => deleteMessageMedia(prisma, { tenantId: tA, messageId: { in: ["msg-1", "msg-2"] } }))).resolves.toBe(2);
  expect(store.keys().filter((k) => k.includes("/wa/"))).toEqual([]);
});

it("imagem do cabeçalho de template: troca, lê e apaga junto com o arquivo", async () => {
  await runWithTenantContextAsync(tA, async () => {
    await saveTemplateMedia(prisma, tA, templateA, { mime: "image/jpeg", filename: "a.jpg", data: bytes("v1") });
    await saveTemplateMedia(prisma, tA, templateA, { mime: "image/png", filename: "b.png", data: bytes("v2") });
    expect(await loadTemplateMedia(prisma, tA, templateA)).toMatchObject({ mime: "image/png", filename: "b.png", size: 2 });
    expect((await loadTemplateMedia(prisma, tA, templateA))?.data.toString()).toBe("v2");
    await deleteTemplateMedia(prisma, tA, templateA);
    expect(await loadTemplateMedia(prisma, tA, templateA)).toBeNull();
  });
  expect(store.keys()).toEqual([]);
});

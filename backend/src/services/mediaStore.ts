import type { AppPrismaClient } from "../config/db";

/**
 * Arquivos de mídia fora do banco (o D1 não guarda linha acima de 2 MB; as mídias vão até 4 MB): o conteúdo vai
 * para o R2 (binding MEDIA, registrado pelo Worker em configureMediaStore) e o banco fica só com os metadados e a
 * chave (`storageKey`) nas tabelas WaMediaBlob e TemplateMedia. Toda chave começa por `t/{tenantId}/`, e quem lê
 * só chega à chave pela linha do próprio tenant (o tenantGuard filtra a busca).
 *
 * Ordem das operações, pensando na LGPD (mídia de conversa é dado pessoal):
 *  - gravar: objeto primeiro, linha depois (linha sem objeto seria "arquivo sumido");
 *  - apagar: objetos primeiro, linhas depois; se o R2 falhar, as linhas ficam e a retenção tenta de novo no dia
 *    seguinte, em vez de sobrar arquivo sem registro que ninguém mais acharia para apagar.
 * No Node (servidor local, testes) o padrão é um armazenamento em memória.
 */
export interface MediaStore {
  put(key: string, data: Uint8Array, mime: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(keys: string[]): Promise<void>;
}

export function memoryMediaStore(): MediaStore & { keys(): string[] } {
  const objetos = new Map<string, Uint8Array>();
  return {
    async put(key, data) {
      objetos.set(key, new Uint8Array(data));
    },
    async get(key) {
      return objetos.get(key) ?? null;
    },
    async delete(keys) {
      for (const k of keys) objetos.delete(k);
    },
    keys: () => [...objetos.keys()],
  };
}

/** Bucket R2 (só o que usamos da API dele). */
interface R2Like {
  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(keys: string | string[]): Promise<void>;
}

const R2_DELETE_MAX = 1000;

export function r2MediaStore(bucket: R2Like): MediaStore {
  return {
    async put(key, data, mime) {
      await bucket.put(key, data, { httpMetadata: { contentType: mime } });
    },
    async get(key) {
      const obj = await bucket.get(key);
      return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
    },
    async delete(keys) {
      for (let i = 0; i < keys.length; i += R2_DELETE_MAX) await bucket.delete(keys.slice(i, i + R2_DELETE_MAX));
    },
  };
}

let store: MediaStore = memoryMediaStore();

export function configureMediaStore(s: MediaStore): void {
  store = s;
}

export const messageMediaKey = (tenantId: string, messageId: string) => `t/${tenantId}/wa/${messageId}`;
export const templateMediaKey = (tenantId: string, templateId: string) => `t/${tenantId}/tpl/${templateId}`;

/* ---------------------------- Mídia de mensagem do WhatsApp (WaMediaBlob) ---------------------------- */

/** Guarda o arquivo de uma mensagem. Linha já existente (outra requisição guardou antes) não é erro. */
export async function saveMessageMedia(prisma: AppPrismaClient, tenantId: string, messageId: string, file: { mime: string; data: Uint8Array }) {
  const storageKey = messageMediaKey(tenantId, messageId);
  await store.put(storageKey, file.data, file.mime);
  await prisma.waMediaBlob.create({ data: { tenantId, messageId, mime: file.mime, size: file.data.length, storageKey } }).catch((e) => {
    // mesma chave (é derivada do messageId): o objeto gravado é o mesmo arquivo, então não se apaga nada
    if (!/P2002|UNIQUE constraint failed/i.test(`${(e as { code?: string }).code} ${(e as Error).message}`)) throw e;
  });
}

export async function loadMessageMedia(prisma: AppPrismaClient, tenantId: string, messageId: string): Promise<{ mime: string; data: Buffer } | null> {
  const row = await prisma.waMediaBlob.findFirst({ where: { tenantId, messageId }, select: { mime: true, storageKey: true } });
  if (!row) return null;
  const data = await store.get(row.storageKey);
  return data ? { mime: row.mime, data: Buffer.from(data) } : null;
}

/** Apaga as mídias de mensagem que casam com o filtro (objetos no R2 e linhas). Devolve quantas linhas saíram. */
export async function deleteMessageMedia(
  prisma: AppPrismaClient,
  where: { tenantId: string; messageId?: { in: string[] }; createdAt?: { lte: Date } }
): Promise<number> {
  const rows = await prisma.waMediaBlob.findMany({ where, select: { id: true, storageKey: true } });
  if (rows.length === 0) return 0;
  await store.delete(rows.map((r) => r.storageKey));
  return (await prisma.waMediaBlob.deleteMany({ where: { tenantId: where.tenantId, id: { in: rows.map((r) => r.id) } } })).count;
}

/* --------------------------------- Imagem do cabeçalho de template (TemplateMedia) --------------------------------- */

export async function saveTemplateMedia(
  prisma: AppPrismaClient,
  tenantId: string,
  templateId: string,
  file: { mime: string; filename: string; data: Uint8Array }
) {
  const storageKey = templateMediaKey(tenantId, templateId);
  await store.put(storageKey, file.data, file.mime);
  const meta = { mime: file.mime, filename: file.filename, size: file.data.length, storageKey };
  await prisma.templateMedia.upsert({ where: { templateId }, create: { tenantId, templateId, ...meta }, update: meta });
}

export async function loadTemplateMedia(
  prisma: AppPrismaClient,
  tenantId: string,
  templateId: string
): Promise<{ mime: string; filename: string; size: number; data: Buffer } | null> {
  const row = await prisma.templateMedia.findFirst({ where: { tenantId, templateId }, select: { mime: true, filename: true, size: true, storageKey: true } });
  if (!row) return null;
  const data = await store.get(row.storageKey);
  return data ? { mime: row.mime, filename: row.filename, size: row.size, data: Buffer.from(data) } : null;
}

export async function deleteTemplateMedia(prisma: AppPrismaClient, tenantId: string, templateId: string): Promise<void> {
  const rows = await prisma.templateMedia.findMany({ where: { tenantId, templateId }, select: { storageKey: true } });
  if (rows.length) await store.delete(rows.map((r) => r.storageKey));
  await prisma.templateMedia.deleteMany({ where: { tenantId, templateId } });
}

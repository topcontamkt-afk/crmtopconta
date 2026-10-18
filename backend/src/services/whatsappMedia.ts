import { AppPrismaClient } from "../config/db";

/**
 * Mídia recebida pelo WhatsApp (imagem, áudio, vídeo, documento, figurinha). O webhook só traz o
 * `media_id`; o arquivo é buscado em 2 passos na Graph API: (1) GET /{media-id} devolve uma URL
 * temporária, (2) GET nessa URL, COM o token, devolve os bytes. A cópia fica em WaMediaBlob porque a
 * Meta só guarda a mídia por tempo limitado.
 *
 * Limite de 4 MB: a Vercel não devolve respostas acima de ~4,5 MB, então arquivos maiores não são
 * guardados nem servidos (a tela avisa).
 */
export const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || "v20.0";
export const MEDIA_MAX_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;

/** Tipos que o navegador pode exibir sem risco; qualquer outro vira download. */
const INLINE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/amr",
  "audio/webm",
  "video/mp4",
  "video/3gpp",
  "application/pdf",
]);

/** "audio/ogg; codecs=opus" -> "audio/ogg" */
export function baseMime(mime: string | null | undefined): string {
  return (mime || "application/octet-stream").split(";")[0].trim().toLowerCase();
}

export function isInlineSafeMime(mime: string | null | undefined): boolean {
  return INLINE_MIMES.has(baseMime(mime));
}

export class MediaError extends Error {
  constructor(public code: "SEM_TOKEN" | "INDISPONIVEL" | "MUITO_GRANDE", message: string) {
    super(message);
  }
}

export interface FetchedMedia {
  data: Buffer;
  mime: string;
}

type FetchLike = (url: string, init?: any) => Promise<any>;

/** Busca o arquivo na Meta (2 passos). `fetchImpl` é injetável para teste. */
export async function fetchMetaMedia(mediaId: string, token: string | undefined, fetchImpl: FetchLike = fetch as any): Promise<FetchedMedia> {
  if (!token) throw new MediaError("SEM_TOKEN", "Token de acesso da Meta não configurado");
  const headers = { Authorization: `Bearer ${token}` };
  const signal = () => AbortSignal.timeout(FETCH_TIMEOUT_MS);

  let meta: any;
  try {
    const r = await fetchImpl(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${encodeURIComponent(mediaId)}`, { headers, signal: signal() });
    if (!r.ok) throw new MediaError("INDISPONIVEL", `Meta recusou a consulta da mídia (HTTP ${r.status}); ela pode ter expirado`);
    meta = await r.json();
  } catch (e) {
    if (e instanceof MediaError) throw e;
    throw new MediaError("INDISPONIVEL", `Falha ao consultar a mídia na Meta: ${(e as Error).message}`);
  }
  if (!meta?.url) throw new MediaError("INDISPONIVEL", "A Meta não devolveu a URL da mídia");
  if (typeof meta.file_size === "number" && meta.file_size > MEDIA_MAX_BYTES) {
    throw new MediaError("MUITO_GRANDE", `Arquivo de ${(meta.file_size / 1048576).toFixed(1)} MB passa do limite de 4 MB`);
  }

  try {
    const r = await fetchImpl(meta.url, { headers, signal: signal() });
    if (!r.ok) throw new MediaError("INDISPONIVEL", `Download da mídia falhou (HTTP ${r.status})`);
    const data = Buffer.from(await r.arrayBuffer());
    if (data.length > MEDIA_MAX_BYTES) throw new MediaError("MUITO_GRANDE", "Arquivo passa do limite de 4 MB");
    return { data, mime: baseMime(meta.mime_type || r.headers?.get?.("content-type")) };
  } catch (e) {
    if (e instanceof MediaError) throw e;
    throw new MediaError("INDISPONIVEL", `Falha ao baixar a mídia: ${(e as Error).message}`);
  }
}

export interface CachedMedia {
  data: Buffer;
  mime: string;
}

/**
 * Devolve a mídia da mensagem: da cópia local se já existe; senão busca na Meta e guarda.
 * Roda no contexto do tenant (a rota e o webhook já estão nele).
 */
export async function getOrCacheMessageMedia(
  prisma: AppPrismaClient,
  tenantId: string,
  message: { id: string; mediaId: string | null },
  token: string | undefined,
  fetchImpl?: FetchLike
): Promise<CachedMedia> {
  const cached = await prisma.waMediaBlob.findFirst({ where: { tenantId, messageId: message.id } });
  if (cached) return { data: Buffer.from(cached.data), mime: cached.mime };
  if (!message.mediaId) throw new MediaError("INDISPONIVEL", "Mensagem sem mídia");
  // Z-API: o arquivo só existe se foi baixado e guardado na hora do webhook (não há como buscar depois)
  if (message.mediaId === "zapi") throw new MediaError("INDISPONIVEL", "O arquivo da Z-API não foi guardado (passou de 4 MB ou o link expirou).");

  const fetched = await fetchMetaMedia(message.mediaId, token, fetchImpl);
  try {
    await prisma.waMediaBlob.create({ data: { tenantId, messageId: message.id, mime: fetched.mime, size: fetched.data.length, data: fetched.data } });
  } catch {
    // outra requisição guardou ao mesmo tempo (messageId é único): serve o que já baixamos
  }
  return fetched;
}

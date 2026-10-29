import { MEDIA_MAX_BYTES } from "./whatsappMedia";

/** Só baixa de https e de host com nome (não IP, localhost nem rede interna): o link vem de um webhook. */
export function isSafeMediaUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || h === "localhost" || /^[\d.]+$/.test(h) || h.includes(":") || h.endsWith(".local") || h.endsWith(".internal")) return false;
  return true;
}

/** Baixa o arquivo recebido pela Z-API (até 4 MB, o que a Vercel devolve). */
export async function downloadZapiMedia(rawUrl: string, mimeHint: string | null, fetchImpl: (url: string, init?: any) => Promise<any> = fetch as any): Promise<{ data: Buffer; mime: string }> {
  if (!isSafeMediaUrl(rawUrl)) throw new Error("endereço do arquivo não aceito");
  const r = await fetchImpl(rawUrl, { signal: AbortSignal.timeout(15000), redirect: "error" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length === 0) throw new Error("arquivo vazio");
  if (buf.length > MEDIA_MAX_BYTES) throw new Error("arquivo maior que o limite guardado");
  const mime = (mimeHint || r.headers?.get?.("content-type") || "application/octet-stream").split(";")[0].trim();
  return { data: buf, mime };
}

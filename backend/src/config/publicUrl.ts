/**
 * Endereço público do backend, de onde saem as URLs que vão para fora (webhooks colados na Meta/Z-API/Twilio,
 * links rastreados dos templates, TwiML da ligação). Vem só de PUBLIC_BACKEND_URL (vars do wrangler por ambiente
 * ou .env): sem ela, quem depende do endereço avisa em vez de gerar URL de outro ambiente.
 */
const semBarraNoFim = (url: string) => url.trim().replace(/\/+$/, "");

/** PUBLIC_BACKEND_URL sem barra no fim, ou null se não configurada. */
export function publicBackendUrl(): string | null {
  const url = process.env.PUBLIC_BACKEND_URL;
  return url && url.trim() ? semBarraNoFim(url) : null;
}

type ReqComUrl = { originalUrl: string; protocol: string; headers: Record<string, string | string[] | undefined>; get(name: string): string | undefined };

/**
 * URL exatamente como o provedor (Twilio) a chamou e assinou: PUBLIC_BACKEND_URL + caminho. Sem ela (Node local),
 * protocolo e host da própria requisição, como antes.
 */
export function publicUrlOfRequest(req: ReqComUrl): string {
  const base = publicBackendUrl();
  if (base) return `${base}${req.originalUrl}`;
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] || req.protocol;
  const host = (req.headers["x-forwarded-host"] as string | undefined) || req.get("host") || "";
  return `${proto}://${host}${req.originalUrl}`;
}

/**
 * Acesso às APIs do Google com a Service Account (GOOGLE_SERVICE_ACCOUNT_JSON) só com `fetch` e WebCrypto, no
 * lugar do pacote `googleapis` (pesado demais para o Worker). Fluxo OAuth 2.0 de conta de serviço: um JWT RS256
 * assinado com a chave privada (`assertion`) é trocado por um token de acesso no `token_uri`, com o escopo pedido.
 * O token fica em memória da instância até 1 minuto antes de vencer (1 h), por escopo.
 */

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<any>;
}>;

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const TOKEN_URI = "https://oauth2.googleapis.com/token";

export class GoogleApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function serviceAccount(): ServiceAccount {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON não configurado. Defina a credencial da Service Account " +
        "(Integrações → Google Sheets) para habilitar a sincronização automática."
    );
  }
  const sa = JSON.parse(raw) as Partial<ServiceAccount>;
  if (!sa.client_email || !sa.private_key) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON sem client_email ou private_key.");
  return sa as ServiceAccount;
}

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const base64urlJson = (v: unknown) => base64url(new TextEncoder().encode(JSON.stringify(v)));

/** PEM PKCS#8 ("-----BEGIN PRIVATE KEY-----") → bytes DER. */
function pemParaDer(pem: string): Uint8Array {
  const corpo = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\\n/g, "").replace(/\s+/g, "");
  return new Uint8Array(Buffer.from(corpo, "base64"));
}

/** JWT RS256 que a conta de serviço apresenta ao `token_uri` (RFC 7523). */
export async function assinarAssertion(sa: ServiceAccount, scope: string, agora = Date.now()): Promise<string> {
  const iat = Math.floor(agora / 1000);
  const claims = { iss: sa.client_email, scope, aud: sa.token_uri || TOKEN_URI, iat, exp: iat + 3600 };
  const conteudo = `${base64urlJson({ alg: "RS256", typ: "JWT" })}.${base64urlJson(claims)}`;
  const chave = await crypto.subtle.importKey("pkcs8", pemParaDer(sa.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const assinatura = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", chave, new TextEncoder().encode(conteudo));
  return `${conteudo}.${base64url(new Uint8Array(assinatura))}`;
}

const tokens = new Map<string, { token: string; venceEm: number }>();

/** Só para testes: esquece os tokens guardados. */
export function resetGoogleTokens() {
  tokens.clear();
}

async function accessToken(scope: string, fetchImpl: FetchLike): Promise<string> {
  const sa = serviceAccount();
  const chave = `${sa.client_email}|${scope}`;
  const guardado = tokens.get(chave);
  if (guardado && guardado.venceEm > Date.now() + 60_000) return guardado.token;

  const resp = await fetchImpl(sa.token_uri || TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: await assinarAssertion(sa, scope) }).toString(),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok || typeof j?.access_token !== "string") {
    throw new GoogleApiError(resp.status, `Google recusou a credencial da Service Account: ${j?.error_description || j?.error || resp.status}`);
  }
  tokens.set(chave, { token: j.access_token, venceEm: Date.now() + (Number(j.expires_in) || 3600) * 1000 });
  return j.access_token;
}

/** Chamada autenticada a uma API do Google (JSON) com o escopo informado. */
export async function googleFetch<T = any>(
  scope: string,
  url: string,
  init: { method?: string; body?: unknown } = {},
  fetchImpl: FetchLike = fetch as unknown as FetchLike
): Promise<T> {
  const token = await accessToken(scope, fetchImpl);
  const resp = await fetchImpl(url, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${token}`, ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new GoogleApiError(resp.status, `Google Sheets: ${j?.error?.message || resp.status}`);
  return j as T;
}

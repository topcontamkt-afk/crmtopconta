import { generateKeyPairSync, verify } from "node:crypto";
import { assinarAssertion, GoogleApiError, googleFetch, resetGoogleTokens } from "./googleApi";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const SA = { client_email: "crm@projeto.iam.gserviceaccount.com", private_key: pem };

const decodifica = (parte: string) => JSON.parse(Buffer.from(parte, "base64url").toString());

/** fetch falso: o endpoint de token confere o JWT e devolve um token; a API devolve `api`. */
function fakeFetch(api: { status?: number; body: any } = { body: { ok: true } }) {
  const chamadas: { url: string; init: any }[] = [];
  const impl = async (url: string, init: any = {}) => {
    chamadas.push({ url, init });
    if (url === "https://oauth2.googleapis.com/token") {
      const assertion = new URLSearchParams(init.body).get("assertion")!;
      const [h, c, s] = assertion.split(".");
      const valido = verify("sha256", Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, "base64url"));
      return { ok: valido, status: valido ? 200 : 400, json: async () => (valido ? { access_token: "tok-1", expires_in: 3600 } : { error: "invalid_grant" }) };
    }
    return { ok: (api.status ?? 200) < 400, status: api.status ?? 200, json: async () => api.body };
  };
  return { impl, chamadas };
}

beforeEach(() => {
  resetGoogleTokens();
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify(SA);
});

describe("assinarAssertion (JWT RS256 da conta de serviço, WebCrypto)", () => {
  it("cabeçalho, claims e assinatura que a chave pública confere", async () => {
    const jwt = await assinarAssertion(SA, "escopo-x", Date.UTC(2026, 9, 19));
    const [h, c, s] = jwt.split(".");
    expect(decodifica(h)).toEqual({ alg: "RS256", typ: "JWT" });
    const iat = Date.UTC(2026, 9, 19) / 1000;
    expect(decodifica(c)).toEqual({ iss: SA.client_email, scope: "escopo-x", aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 });
    expect(verify("sha256", Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });
});

describe("googleFetch", () => {
  it("troca o JWT por um token e chama a API com Bearer; o token é reaproveitado por escopo", async () => {
    const { impl, chamadas } = fakeFetch({ body: { values: [["a"]] } });
    await expect(googleFetch("escopo-x", "https://sheets.googleapis.com/v4/spreadsheets/P/values/A1", {}, impl as any)).resolves.toEqual({ values: [["a"]] });
    await googleFetch("escopo-x", "https://sheets.googleapis.com/v4/spreadsheets/P/values/A2", {}, impl as any);
    expect(chamadas.map((c) => c.url.split("?")[0])).toEqual([
      "https://oauth2.googleapis.com/token",
      "https://sheets.googleapis.com/v4/spreadsheets/P/values/A1",
      "https://sheets.googleapis.com/v4/spreadsheets/P/values/A2",
    ]);
    expect(new URLSearchParams(chamadas[0].init.body).get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(chamadas[1].init.headers.Authorization).toBe("Bearer tok-1");

    await googleFetch("escopo-y", "https://x", {}, impl as any);
    expect(chamadas.filter((c) => c.url.includes("oauth2"))).toHaveLength(2);
  });

  it("corpo vai como JSON; erro da API vira GoogleApiError com a mensagem do Google, sem o token", async () => {
    const { impl, chamadas } = fakeFetch({ status: 403, body: { error: { message: "The caller does not have permission" } } });
    const erro = await googleFetch("escopo-x", "https://x", { method: "PUT", body: { values: [] } }, impl as any).catch((e) => e);
    expect(erro).toBeInstanceOf(GoogleApiError);
    expect(erro).toMatchObject({ status: 403, message: "Google Sheets: The caller does not have permission" });
    expect(erro.message).not.toContain("tok-1");
    expect(chamadas[1].init).toMatchObject({ method: "PUT", body: '{"values":[]}' });
  });

  it("sem credencial configurada, erro claro antes de qualquer chamada", async () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    const { impl, chamadas } = fakeFetch();
    await expect(googleFetch("escopo-x", "https://x", {}, impl as any)).rejects.toThrow(/GOOGLE_SERVICE_ACCOUNT_JSON não configurado/);
    expect(chamadas).toHaveLength(0);
  });
});

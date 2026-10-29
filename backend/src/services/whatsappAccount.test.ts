import crypto from "crypto";
import { credentialsOf, encryptCredentials, generateVerifyToken, globalCredentialsAllowed, hint, maskedHint } from "./whatsappAccount";

describe("credenciais da conta WhatsApp", () => {
  const OLD = { ...process.env };
  beforeEach(() => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    delete process.env.WHATSAPP_APP_SECRET;
    delete process.env.ALLOW_GLOBAL_CHANNEL_CREDENTIALS;
    delete process.env.PLATFORM_DEFAULT_TENANT_ID;
  });
  afterAll(() => {
    process.env = OLD;
  });

  it("cifra e decifra token e segredo; o JSON guardado não contém o texto puro", () => {
    const enc = encryptCredentials({ accessToken: "EAAGsecretTOKEN123", appSecret: "appsecret456" });
    expect(JSON.stringify(enc)).not.toContain("EAAGsecretTOKEN123");
    expect(JSON.stringify(enc)).not.toContain("appsecret456");
    expect(credentialsOf({ credentials: enc })).toEqual({ accessToken: "EAAGsecretTOKEN123", appSecret: "appsecret456" });
  });

  // LGPD 06-01: o token GLOBAL (envia dados de clientes) não é usado por tenant sem liberação explícita
  it("sem credenciais na conta e sem liberação: NÃO usa o token do ambiente (o segredo do webhook continua)", () => {
    process.env.WHATSAPP_ACCESS_TOKEN = "ENV_TOKEN";
    process.env.WHATSAPP_APP_SECRET = "ENV_SECRET";
    expect(credentialsOf({ credentials: null, tenantId: "tB" })).toEqual({ accessToken: undefined, appSecret: "ENV_SECRET" });
    expect(credentialsOf(null)).toEqual({ accessToken: undefined, appSecret: "ENV_SECRET" });
  });

  it("com ALLOW_GLOBAL_CHANNEL_CREDENTIALS=true (dev) usa o ambiente como reserva", () => {
    process.env.WHATSAPP_ACCESS_TOKEN = "ENV_TOKEN";
    process.env.WHATSAPP_APP_SECRET = "ENV_SECRET";
    process.env.ALLOW_GLOBAL_CHANNEL_CREDENTIALS = "true";
    expect(credentialsOf({ credentials: null })).toEqual({ accessToken: "ENV_TOKEN", appSecret: "ENV_SECRET" });
  });

  it("com PLATFORM_DEFAULT_TENANT_ID só o tenant dono das credenciais do ambiente usa a reserva", () => {
    process.env.WHATSAPP_ACCESS_TOKEN = "ENV_TOKEN";
    process.env.PLATFORM_DEFAULT_TENANT_ID = "tA";
    expect(credentialsOf({ credentials: null, tenantId: "tA" }).accessToken).toBe("ENV_TOKEN");
    expect(credentialsOf({ credentials: null, tenantId: "tB" }).accessToken).toBeUndefined();
    expect(credentialsOf(null).accessToken).toBeUndefined();
    expect(globalCredentialsAllowed("tA")).toBe(true);
    expect(globalCredentialsAllowed("tB")).toBe(false);
    expect(globalCredentialsAllowed(undefined)).toBe(false);
  });

  it("as credenciais da conta têm prioridade sobre o ambiente", () => {
    process.env.WHATSAPP_ACCESS_TOKEN = "ENV_TOKEN";
    const enc = encryptCredentials({ accessToken: "ACCOUNT_TOKEN", appSecret: "S" });
    expect(credentialsOf({ credentials: enc }).accessToken).toBe("ACCOUNT_TOKEN");
  });

  it("credencial corrompida não derruba: cai na reserva e devolve indefinido sem ela", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    expect(credentialsOf({ credentials: { iv: "x", authTag: "y", ciphertext: "z" } })).toEqual({ accessToken: undefined, appSecret: undefined });
    spy.mockRestore();
  });

  it("só os 4 últimos caracteres vão para a tela", () => {
    expect(hint("EAAGsecretTOKEN1234")).toBe("1234");
    expect(maskedHint("1234")).toMatch(/^•+1234$/);
    expect(maskedHint(null)).toBeNull();
  });

  it("o token de verificação é aleatório e único", () => {
    const a = generateVerifyToken();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(generateVerifyToken()).not.toBe(a);
  });
});

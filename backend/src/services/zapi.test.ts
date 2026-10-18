import { ZapiAdapter, ZAPI_BATCH_MAX } from "./channels/zapi";
import { resolveWhatsAppTemplate } from "./campaignQueue";
import { isSafeMediaUrl, downloadZapiMedia } from "./zapiMedia";
import { sendReply } from "./whatsappReply";
import { encryptZapiCredentials, instanceIdOf, parseZapiWebhook, zapiAccountKey, zapiCredentialsOf, zapiPhone, zapiQrImage, zapiSendText, zapiSetWebhooks, zapiStatus, zapiStatusToOurs } from "./zapi";

const creds = { instanceId: "INST12345", token: "TOK12345", clientToken: "CLI" };
const resp = (body: any, ok = true, status = 200) => ({ ok, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });

describe("chamadas à Z-API", () => {
  it("monta a URL com instância e token e manda o Client-Token", async () => {
    const f = jest.fn(async () => resp({ connected: true, smartphoneConnected: true }));
    const s = await zapiStatus(creds, f as any);
    expect(s).toEqual({ connected: true, smartphoneConnected: true, error: null });
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("https://api.z-api.io/instances/INST12345/token/TOK12345/status");
    expect(init.headers["Client-Token"]).toBe("CLI");
  });

  it("sem Client-Token não manda o cabeçalho", async () => {
    const f = jest.fn(async () => resp({ connected: false, error: "You are not connected." }));
    const s = await zapiStatus({ ...creds, clientToken: undefined }, f as any);
    expect(s).toMatchObject({ connected: false, error: "You are not connected." });
    expect((f.mock.calls[0] as any)[1].headers["Client-Token"]).toBeUndefined();
  });

  it("envia texto com telefone só de dígitos e devolve o id", async () => {
    const f = jest.fn(async () => resp({ zaapId: "Z1", messageId: "M1", id: "M1" }));
    expect(await zapiSendText(creds, "(79) 99837-2540", "oi", { delayMessage: 3 }, f as any)).toBe("M1");
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toContain("/send-text");
    expect(JSON.parse(init.body)).toEqual({ phone: "5579998372540", message: "oi", delayMessage: 3 });
  });

  it("erro da Z-API vira mensagem clara", async () => {
    const f = jest.fn(async () => resp({ error: "null not allowed" }, false, 400));
    await expect(zapiSendText(creds, "5579999990000", "oi", {}, f as any)).rejects.toThrow(/null not allowed/);
  });

  it("QR code: aceita JSON {value} e texto puro, e vira data URL", async () => {
    expect(await zapiQrImage(creds, (async () => resp({ value: "data:image/png;base64,AAA" })) as any)).toBe("data:image/png;base64,AAA");
    expect(await zapiQrImage(creds, (async () => resp({ value: "AAA" })) as any)).toBe("data:image/png;base64,AAA");
    expect(await zapiQrImage(creds, (async () => resp("BBB")) as any)).toBe("data:image/png;base64,BBB");
  });

  it("webhook: só HTTPS", async () => {
    await expect(zapiSetWebhooks(creds, "http://x.com/a", jest.fn() as any)).rejects.toThrow(/HTTPS/);
    const f = jest.fn(async () => resp({ value: true }));
    await zapiSetWebhooks(creds, "https://x.com/a", f as any);
    expect(JSON.parse((f.mock.calls[0] as any)[1].body)).toEqual({ value: "https://x.com/a", notifySentByMe: false });
  });

  it("telefone: acrescenta 55 só se faltar o DDI", () => {
    expect(zapiPhone("79998372540")).toBe("5579998372540");
    expect(zapiPhone("+55 79 99837-2540")).toBe("5579998372540");
  });
});

describe("credenciais", () => {
  const OLD = process.env.CREDENTIALS_ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  });
  afterAll(() => {
    if (OLD === undefined) delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    else process.env.CREDENTIALS_ENCRYPTION_KEY = OLD;
  });
  it("cifra e decifra; instanceId vem do phoneNumberId", () => {
    const account = { phoneNumberId: zapiAccountKey("INST12345"), credentials: encryptZapiCredentials({ token: "TOK12345", clientToken: "CLI" }) };
    expect(zapiCredentialsOf(account)).toEqual({ instanceId: "INST12345", token: "TOK12345", clientToken: "CLI" });
    expect(instanceIdOf("zapi:ABC")).toBe("ABC");
    expect(zapiCredentialsOf({ phoneNumberId: "zapi:x", credentials: null })).toBeNull();
  });
});

describe("parseZapiWebhook", () => {
  const base = { type: "ReceivedCallback", instanceId: "INST12345", messageId: "M1", phone: "5579998372540", fromMe: false, momment: 1792284000000, isGroup: false, senderName: "Maria" };
  it("lê mensagem de texto", () => {
    const e = parseZapiWebhook({ ...base, text: { message: "oi" } }, "INST12345");
    expect(e.kind).toBe("message");
    if (e.kind === "message") {
      expect(e.message).toMatchObject({ waId: "5579998372540", wamid: "M1", type: "text", body: "oi", contactName: "Maria", phoneNumberId: "zapi:INST12345", mediaId: null });
      expect(e.message.timestamp.getTime()).toBe(1792284000000);
    }
  });
  it("lê imagem com legenda e guarda o link para baixar", () => {
    const e = parseZapiWebhook({ ...base, image: { imageUrl: "https://cdn.x.com/a.jpg", caption: "foto", mimeType: "image/jpeg" } }, "INST12345");
    expect(e.kind === "message" && e.message).toMatchObject({ type: "image", body: "foto", mediaId: "zapi", mediaMime: "image/jpeg", mediaUrl: "https://cdn.x.com/a.jpg" });
  });
  it("ignora o que não é mensagem nova de contato", () => {
    for (const extra of [{ fromMe: true }, { isGroup: true }, { isNewsletter: true }, { isStatusReply: true }, { isEdit: true }, { waitingMessage: true }, { phone: "" }]) {
      expect(parseZapiWebhook({ ...base, ...extra, text: { message: "x" } }, "INST12345").kind).toBe("ignore");
    }
    expect(parseZapiWebhook({ ...base, text: { message: "x" } }, "OUTRA").kind).toBe("ignore");
    expect(parseZapiWebhook({ type: "DeliveryCallback" }, "INST12345").kind).toBe("ignore");
    expect(parseZapiWebhook(null, "INST12345").kind).toBe("ignore");
  });
  it("status de entrega", () => {
    const e = parseZapiWebhook({ type: "MessageStatusCallback", instanceId: "INST12345", status: "READ", ids: ["A", "B"] }, "INST12345");
    expect(e).toEqual({ kind: "status", ids: ["A", "B"], status: "READ" });
    expect(zapiStatusToOurs("SENT")).toBe("sent");
    expect(zapiStatusToOurs("RECEIVED")).toBe("delivered");
    expect(zapiStatusToOurs("READ")).toBe("read");
    expect(zapiStatusToOurs("READ_BY_ME")).toBeNull();
  });
});

describe("mídia da Z-API", () => {
  it("só baixa de https com nome de host público", () => {
    expect(isSafeMediaUrl("https://cdn.z-api.io/a.jpg")).toBe(true);
    for (const u of ["http://cdn.x.com/a", "https://localhost/a", "https://127.0.0.1/a", "https://10.0.0.1/a", "https://[::1]/a", "https://intranet/a", "https://x.internal/a", "ftp://x.com/a", "lixo"]) {
      expect(isSafeMediaUrl(u)).toBe(false);
    }
  });
  it("baixa com o tipo do webhook e recusa arquivo grande", async () => {
    const ok = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, headers: { get: () => "image/png" } });
    expect(await downloadZapiMedia("https://cdn.x.com/a.png", "audio/ogg; codecs=opus", ok as any)).toMatchObject({ mime: "audio/ogg" });
    const big = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(5 * 1024 * 1024), headers: { get: () => null } });
    await expect(downloadZapiMedia("https://cdn.x.com/a.png", null, big as any)).rejects.toThrow(/limite/);
    await expect(downloadZapiMedia("http://x.com/a", null, ok as any)).rejects.toThrow(/endereço/);
  });
});

describe("campanha pela Z-API", () => {
  it("o adaptador manda texto com pausa e devolve o id", async () => {
    const f = jest.fn(async () => resp({ messageId: "M9" }));
    const pause = jest.fn(async () => undefined);
    const r = await new ZapiAdapter(creds, f as any, pause).send("5579999990000", "Olá");
    expect(r).toEqual({ providerMessageId: "M9", status: "SENT" });
    expect(pause).toHaveBeenCalledTimes(1);
    expect(JSON.parse((f.mock.calls[0] as any)[1].body).delayMessage).toBeGreaterThanOrEqual(2);
  });
  it("falha vira FAILED, sem lançar", async () => {
    const f = jest.fn(async () => resp({ error: "x" }, false, 500));
    expect(await new ZapiAdapter(creds, f as any, async () => undefined).send("5579999990000", "Olá")).toMatchObject({ status: "FAILED" });
  });
  it("lote pequeno", () => expect(ZAPI_BATCH_MAX).toBeLessThanOrEqual(5));

  it("com Z-API ativa não exige template aprovado da Meta; sem Z-API configurada bloqueia", async () => {
    const campaign = { tenantId: "t1", channel: "WHATSAPP", templateId: "tpl1" };
    const prisma: any = { messageTemplate: { findFirst: jest.fn(async () => null) } };
    expect(await resolveWhatsAppTemplate(prisma, campaign, [{ name: "zapi", adapter: new ZapiAdapter(creds) }])).toEqual({ template: null });
    expect(await resolveWhatsAppTemplate(prisma, campaign, [])).toMatchObject({ bloqueado: expect.stringContaining("Z-API") });
  });
});

describe("responder pela Inbox em conversa da Z-API", () => {
  const OLD = process.env.CREDENTIALS_ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  });
  afterAll(() => {
    if (OLD === undefined) delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    else process.env.CREDENTIALS_ENCRYPTION_KEY = OLD;
  });
  const fake = (lastInboundAt: Date | null) => {
    const created: any[] = [];
    const prisma: any = {
      conversation: {
        findFirst: jest.fn(async () => ({
          id: "c1",
          waId: "5579999990000",
          lastInboundAt,
          account: { phoneNumberId: "zapi:INST12345", active: true, provider: "ZAPI", credentials: encryptZapiCredentials({ token: "TOK12345", clientToken: "" }) },
        })),
        update: jest.fn(async () => ({})),
      },
      waMessage: { create: jest.fn(async ({ data }: any) => { created.push(data); return { id: "m1", ...data }; }) },
    };
    return { prisma, created };
  };

  it("responde mesmo sem janela de 24h aberta", async () => {
    const { prisma, created } = fake(null);
    const f = jest.fn(async () => resp({ messageId: "Z-OUT-1" }));
    await sendReply(prisma, "t1", "u1", "c1", { tipo: "text", texto: " Olá " }, { fetchImpl: f as any });
    expect(created[0]).toMatchObject({ direction: "SAIDA", wamid: "Z-OUT-1", body: "Olá", status: "sent", sentByUserId: "u1" });
    expect((f.mock.calls[0] as any)[0]).toContain("api.z-api.io");
  });

  it("anexo ainda não é aceito", async () => {
    const { prisma, created } = fake(null);
    await expect(sendReply(prisma, "t1", "u1", "c1", { tipo: "arquivo", nome: "a.png", mime: "image/png", data: Buffer.from([1]) }, { fetchImpl: jest.fn() as any })).rejects.toMatchObject({ code: "TIPO_INVALIDO" });
    expect(created).toHaveLength(0);
  });

  it("se a Z-API recusar, nada é gravado", async () => {
    const { prisma, created } = fake(null);
    const f = jest.fn(async () => resp({ error: "not connected" }, false, 400));
    await expect(sendReply(prisma, "t1", "u1", "c1", { tipo: "text", texto: "oi" }, { fetchImpl: f as any })).rejects.toThrow(/not connected/);
    expect(created).toHaveLength(0);
  });
});

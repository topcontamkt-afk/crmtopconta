import { assertJanelaAberta, explainMetaError, janelaAberta, mediaTypeForMime, SendError, sendMedia, sendText, uploadMedia } from "./whatsappSend";

const ok = (body: any) => ({ ok: true, status: 200, json: async () => body });
const fail = (status: number, body: any) => ({ ok: false, status, json: async () => body });

describe("janela de 24 horas", () => {
  const now = new Date("2026-10-11T12:00:00Z");
  it("aberta até 24h depois da última mensagem do cliente", () => {
    expect(janelaAberta(new Date("2026-10-10T13:00:00Z"), now)).toBe(true);
    expect(janelaAberta(new Date("2026-10-10T12:00:00Z"), now)).toBe(false);
    expect(janelaAberta(null, now)).toBe(false);
  });
  it("assertJanelaAberta lança JANELA_FECHADA", () => {
    expect(() => assertJanelaAberta(null, now)).toThrow(SendError);
    try {
      assertJanelaAberta(new Date("2026-10-01T00:00:00Z"), now);
    } catch (e: any) {
      expect(e.code).toBe("JANELA_FECHADA");
    }
  });
});

describe("tipos de mídia aceitos", () => {
  it("classifica por mime", () => {
    expect(mediaTypeForMime("image/jpeg")).toBe("image");
    expect(mediaTypeForMime("application/pdf")).toBe("document");
    expect(mediaTypeForMime("audio/ogg; codecs=opus")).toBe("audio");
    expect(mediaTypeForMime("video/mp4")).toBe("video");
  });
  it("recusa o que a Meta não aceita", () => {
    expect(mediaTypeForMime("image/svg+xml")).toBeNull();
    expect(mediaTypeForMime("application/zip")).toBeNull();
    expect(mediaTypeForMime("audio/webm")).toBeNull();
  });
});

describe("sendText", () => {
  it("monta o payload de texto e devolve o wamid", async () => {
    const f = jest.fn(async (_u: string, _i?: any) => ok({ messages: [{ id: "wamid.OK" }] }));
    const id = await sendText("1055", "TOKEN", "5584999998888", "Olá!", f as any);
    expect(id).toBe("wamid.OK");
    const [url, init] = f.mock.calls[0] as [string, any];
    expect(url).toContain("/1055/messages");
    expect(init.headers.Authorization).toBe("Bearer TOKEN");
    expect(JSON.parse(init.body)).toMatchObject({ messaging_product: "whatsapp", to: "5584999998888", type: "text", text: { body: "Olá!" } });
  });
  it("sem token nem chama a Meta", async () => {
    const f = jest.fn();
    await expect(sendText("1055", undefined, "55", "x", f as any)).rejects.toMatchObject({ code: "SEM_TOKEN" });
    expect(f).not.toHaveBeenCalled();
  });
  it("traduz o erro de janela fechada da Meta", async () => {
    const f = jest.fn(async () => fail(400, { error: { code: 131047, message: "Re-engagement message" } }));
    await expect(sendText("1055", "T", "55", "x", f as any)).rejects.toMatchObject({ code: "META", metaCode: 131047, message: expect.stringContaining("24 horas") });
  });
  it("erro desconhecido mostra o detalhe da Meta", async () => {
    const f = jest.fn(async () => fail(400, { error: { code: 999, message: "algo estranho" } }));
    await expect(sendText("1055", "T", "55", "x", f as any)).rejects.toMatchObject({ message: expect.stringContaining("algo estranho") });
  });
  it("resposta sem id é erro (não finge que enviou)", async () => {
    const f = jest.fn(async () => ok({}));
    await expect(sendText("1055", "T", "55", "x", f as any)).rejects.toBeInstanceOf(SendError);
  });
});

describe("uploadMedia e sendMedia", () => {
  it("sobe o arquivo (multipart) e devolve o media_id", async () => {
    const f = jest.fn(async (_u: string, _i?: any) => ok({ id: "MEDIA1" }));
    const id = await uploadMedia("1055", "T", Buffer.from("abc"), "application/pdf", "extrato.pdf", f as any);
    expect(id).toBe("MEDIA1");
    const [url, init] = f.mock.calls[0] as [string, any];
    expect(url).toContain("/1055/media");
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("messaging_product")).toBe("whatsapp");
  });
  it("documento leva nome e legenda; áudio não leva legenda", async () => {
    const f = jest.fn(async (_u: string, _i?: any) => ok({ messages: [{ id: "w1" }] }));
    await sendMedia("1055", "T", "55", "document", "M", { caption: "Segue", filename: "extrato.pdf" }, f as any);
    expect(JSON.parse((f.mock.calls[0] as any)[1].body).document).toEqual({ id: "M", caption: "Segue", filename: "extrato.pdf" });
    await sendMedia("1055", "T", "55", "audio", "M", { caption: "ignorada" }, f as any);
    expect(JSON.parse((f.mock.calls[1] as any)[1].body).audio).toEqual({ id: "M" });
  });
});

describe("explainMetaError", () => {
  it("usa o fallback quando o código não é conhecido", () => {
    expect(explainMetaError(undefined, "x")).toBe("x");
    expect(explainMetaError(1, "y")).toBe("y");
    expect(explainMetaError(190, "z")).toContain("token");
  });
});

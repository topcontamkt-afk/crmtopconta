import { baseMime, fetchMetaMedia, getOrCacheMessageMedia, isInlineSafeMime, MediaError, MEDIA_MAX_BYTES } from "./whatsappMedia";

const resp = (body: any, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
  arrayBuffer: async () => (Buffer.isBuffer(body) ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : new ArrayBuffer(0)),
  headers: { get: () => null },
});

describe("mimes", () => {
  it("tira o parâmetro de codec", () => {
    expect(baseMime("audio/ogg; codecs=opus")).toBe("audio/ogg");
    expect(baseMime(null)).toBe("application/octet-stream");
  });
  it("só abre no navegador tipos seguros", () => {
    expect(isInlineSafeMime("image/jpeg")).toBe(true);
    expect(isInlineSafeMime("audio/ogg; codecs=opus")).toBe(true);
    expect(isInlineSafeMime("application/pdf")).toBe(true);
    expect(isInlineSafeMime("text/html")).toBe(false);
    expect(isInlineSafeMime("image/svg+xml")).toBe(false);
    expect(isInlineSafeMime("application/octet-stream")).toBe(false);
  });
});

describe("fetchMetaMedia", () => {
  it("busca a URL e depois os bytes, sempre com o token", async () => {
    const bytes = Buffer.from("PDFDATA");
    const f = jest.fn(async (url: string, _init?: any) => (url.includes("graph.facebook.com") ? resp({ url: "https://cdn/x", mime_type: "application/pdf", file_size: 7 }) : resp(bytes)));
    const r = await fetchMetaMedia("m1", "TOKEN", f as any);
    expect(r.mime).toBe("application/pdf");
    expect(r.data.toString()).toBe("PDFDATA");
    expect(f.mock.calls[0][1].headers.Authorization).toBe("Bearer TOKEN");
    expect(f.mock.calls[1][1].headers.Authorization).toBe("Bearer TOKEN");
  });

  it("sem token não tenta nada", async () => {
    const f = jest.fn();
    await expect(fetchMetaMedia("m1", undefined, f as any)).rejects.toMatchObject({ code: "SEM_TOKEN" });
    expect(f).not.toHaveBeenCalled();
  });

  it("mídia expirada na Meta vira INDISPONIVEL", async () => {
    const f = jest.fn(async () => resp({ error: {} }, false, 404));
    await expect(fetchMetaMedia("m1", "T", f as any)).rejects.toMatchObject({ code: "INDISPONIVEL" });
  });

  it("recusa arquivo grande sem baixar", async () => {
    const f = jest.fn(async () => resp({ url: "https://cdn/x", mime_type: "video/mp4", file_size: MEDIA_MAX_BYTES + 1 }));
    await expect(fetchMetaMedia("m1", "T", f as any)).rejects.toMatchObject({ code: "MUITO_GRANDE" });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("recusa quando o tamanho real passa do limite mesmo sem file_size", async () => {
    const big = Buffer.alloc(MEDIA_MAX_BYTES + 1);
    const f = jest.fn(async (url: string) => (url.includes("graph") ? resp({ url: "https://cdn/x", mime_type: "video/mp4" }) : resp(big)));
    await expect(fetchMetaMedia("m1", "T", f as any)).rejects.toBeInstanceOf(MediaError);
  });
});

describe("getOrCacheMessageMedia", () => {
  const fake = (cached: any) => {
    const created: any[] = [];
    const prisma: any = { waMediaBlob: { findFirst: jest.fn(async () => cached), create: jest.fn(async (a: any) => void created.push(a)) } };
    return { prisma, created };
  };

  it("usa a cópia local sem chamar a Meta", async () => {
    const { prisma } = fake({ data: Buffer.from("x"), mime: "image/png" });
    const f = jest.fn();
    const r = await getOrCacheMessageMedia(prisma, "t1", { id: "m", mediaId: "id" }, "T", f as any);
    expect(r.mime).toBe("image/png");
    expect(f).not.toHaveBeenCalled();
  });

  it("baixa da Meta e guarda na primeira vez", async () => {
    const { prisma, created } = fake(null);
    const f = jest.fn(async (url: string) => (url.includes("graph") ? resp({ url: "https://cdn/x", mime_type: "image/jpeg", file_size: 3 }) : resp(Buffer.from("abc"))));
    const r = await getOrCacheMessageMedia(prisma, "t1", { id: "m", mediaId: "id" }, "T", f as any);
    expect(r.data.toString()).toBe("abc");
    expect(created[0].data).toMatchObject({ tenantId: "t1", messageId: "m", mime: "image/jpeg", size: 3 });
  });

  it("falha ao guardar não impede de mostrar o arquivo", async () => {
    const prisma: any = { waMediaBlob: { findFirst: async () => null, create: async () => { throw new Error("dup"); } } };
    const f = jest.fn(async (url: string) => (url.includes("graph") ? resp({ url: "u", mime_type: "image/png" }) : resp(Buffer.from("z"))));
    await expect(getOrCacheMessageMedia(prisma, "t1", { id: "m", mediaId: "id" }, "T", f as any)).resolves.toMatchObject({ mime: "image/png" });
  });
});

import { applyOutboundStatus, nextOutboundStatus, sendReply } from "./whatsappReply";

const now = new Date("2026-10-11T12:00:00Z");
const ok = (body: any) => ({ ok: true, status: 200, json: async () => body });

function fake(lastInboundAt: Date | null, active = true) {
  const created: any[] = [];
  const blobs: any[] = [];
  const updates: any[] = [];
  const prisma: any = {
    conversation: {
      findFirst: jest.fn(async () => ({ id: "conv1", waId: "5584999998888", lastInboundAt, account: { phoneNumberId: "1055", active } })),
      update: jest.fn(async (a: any) => void updates.push(a)),
    },
    waMessage: { create: jest.fn(async ({ data }: any) => { created.push(data); return { id: "msg1", ...data }; }) },
    waMediaBlob: { create: jest.fn(async (a: any) => void blobs.push(a)) },
  };
  return { prisma, created, blobs, updates };
}

describe("sendReply", () => {
  it("responde texto dentro da janela e grava como enviado", async () => {
    const { prisma, created, updates } = fake(new Date("2026-10-11T08:00:00Z"));
    const f = jest.fn(async () => ok({ messages: [{ id: "wamid.R1" }] }));
    const m = await sendReply(prisma, "t1", "u1", "conv1", { tipo: "text", texto: "  Olá, Maria!  " }, { token: "T", fetchImpl: f, now });
    expect(m.id).toBe("msg1");
    expect(created[0]).toMatchObject({ tenantId: "t1", direction: "SAIDA", wamid: "wamid.R1", status: "sent", sentByUserId: "u1", body: "Olá, Maria!" });
    expect(updates[0].data.lastPreview).toBe("Você: Olá, Maria!");
    expect(updates[0].data.lastInboundAt).toBeUndefined(); // responder não reabre a janela
  });

  it("fora da janela não chama a Meta nem grava nada", async () => {
    const { prisma, created } = fake(new Date("2026-10-09T08:00:00Z"));
    const f = jest.fn();
    await expect(sendReply(prisma, "t1", "u1", "conv1", { tipo: "text", texto: "oi" }, { token: "T", fetchImpl: f, now })).rejects.toMatchObject({ code: "JANELA_FECHADA" });
    expect(f).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it("conversa sem mensagem do cliente também está fechada", async () => {
    const { prisma } = fake(null);
    await expect(sendReply(prisma, "t1", "u1", "conv1", { tipo: "text", texto: "oi" }, { token: "T", now })).rejects.toMatchObject({ code: "JANELA_FECHADA" });
  });

  it("se a Meta recusa, nada é gravado como enviado", async () => {
    const { prisma, created } = fake(new Date("2026-10-11T08:00:00Z"));
    const f = jest.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 131026, message: "undeliverable" } }) }));
    await expect(sendReply(prisma, "t1", "u1", "conv1", { tipo: "text", texto: "oi" }, { token: "T", fetchImpl: f, now })).rejects.toMatchObject({ code: "META", metaCode: 131026 });
    expect(created).toHaveLength(0);
  });

  it("texto vazio é recusado", async () => {
    const { prisma } = fake(new Date("2026-10-11T08:00:00Z"));
    await expect(sendReply(prisma, "t1", "u1", "conv1", { tipo: "text", texto: "   " }, { token: "T", now })).rejects.toMatchObject({ code: "TIPO_INVALIDO" });
  });

  it("envia PDF: sobe o arquivo, envia pelo media_id e guarda a cópia local", async () => {
    const { prisma, created, blobs } = fake(new Date("2026-10-11T08:00:00Z"));
    const f = jest.fn(async (url: string) => (url.endsWith("/media") ? ok({ id: "MEDIA9" }) : ok({ messages: [{ id: "wamid.F" }] })));
    await sendReply(prisma, "t1", "u1", "conv1", { tipo: "arquivo", nome: "Contrato final.pdf", mime: "application/pdf", data: Buffer.from("%PDF-1"), legenda: "Segue" }, { token: "T", fetchImpl: f, now });
    expect(created[0]).toMatchObject({ type: "document", mediaId: "MEDIA9", mediaMime: "application/pdf", body: "Segue", wamid: "wamid.F" });
    expect(blobs[0].data).toMatchObject({ tenantId: "t1", mime: "application/pdf" });
  });

  it("recusa formato não aceito e arquivo grande demais", async () => {
    const { prisma } = fake(new Date("2026-10-11T08:00:00Z"));
    await expect(sendReply(prisma, "t1", "u1", "conv1", { tipo: "arquivo", nome: "a.zip", mime: "application/zip", data: Buffer.from("x") }, { token: "T", now })).rejects.toMatchObject({ code: "TIPO_INVALIDO" });
    await expect(sendReply(prisma, "t1", "u1", "conv1", { tipo: "arquivo", nome: "a.jpg", mime: "image/jpeg", data: Buffer.alloc(3 * 1024 * 1024 + 1) }, { token: "T", now })).rejects.toMatchObject({ code: "MUITO_GRANDE" });
  });

  it("número desativado não envia", async () => {
    const { prisma } = fake(new Date("2026-10-11T08:00:00Z"), false);
    await expect(sendReply(prisma, "t1", "u1", "conv1", { tipo: "text", texto: "oi" }, { token: "T", now })).rejects.toMatchObject({ code: "META" });
  });
});

describe("status de entrega", () => {
  it("só avança: sent → delivered → read", () => {
    expect(nextOutboundStatus("sent", "delivered")).toBe("delivered");
    expect(nextOutboundStatus("delivered", "read")).toBe("read");
    expect(nextOutboundStatus("read", "delivered")).toBeNull();
    expect(nextOutboundStatus("delivered", "sent")).toBeNull();
  });
  it("falha vale sempre; falha pode ser corrigida; status desconhecido é ignorado", () => {
    expect(nextOutboundStatus("read", "failed")).toBe("failed");
    expect(nextOutboundStatus("failed", "delivered")).toBe("delivered");
    expect(nextOutboundStatus("sent", "typing")).toBeNull();
  });

  it("applyOutboundStatus atualiza só mensagens de saída conhecidas", async () => {
    const updates: any[] = [];
    const prisma: any = {
      waMessage: {
        findFirst: jest.fn(async ({ where }: any) => (where.wamid === "w1" ? { id: "m1", status: "sent" } : null)),
        update: jest.fn(async (a: any) => void updates.push(a)),
      },
    };
    expect(await applyOutboundStatus(prisma, "t1", { wamid: "w1", status: "read", errorText: null })).toBe(true);
    expect(updates[0]).toMatchObject({ where: { id: "m1" }, data: { status: "read", errorText: null } });
    expect(await applyOutboundStatus(prisma, "t1", { wamid: "campanha", status: "read", errorText: null })).toBe(false);
  });

  it("falha grava o motivo", async () => {
    const updates: any[] = [];
    const prisma: any = { waMessage: { findFirst: async () => ({ id: "m1", status: "sent" }), update: async (a: any) => void updates.push(a) } };
    await applyOutboundStatus(prisma, "t1", { wamid: "w1", status: "failed", errorText: "131026 Message undeliverable" });
    expect(updates[0].data).toMatchObject({ status: "failed", errorText: "131026 Message undeliverable" });
  });
});

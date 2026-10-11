import { Prisma } from "@prisma/client";
import { storeInboundMessage } from "./whatsappInbox";

jest.mock("../middleware/audit", () => ({ logAudit: jest.fn(async () => undefined) }));
import { logAudit } from "../middleware/audit";

function makeFake(opts: { client?: any; duplicate?: boolean; evento?: any; lastInboundAt?: Date | null } = {}) {
  const calls: Record<string, any[]> = { msgCreate: [], convUpdate: [], clientUpdate: [], eventoUpdate: [] };
  const prisma: any = {
    client: {
      findFirst: jest.fn(async () => opts.client ?? null),
      updateMany: jest.fn(async (a: any) => void calls.clientUpdate.push(a)),
    },
    conversation: {
      upsert: jest.fn(async ({ create }: any) => ({ ...create, id: "conv1", clientId: opts.client?.id ?? null, ...(opts.lastInboundAt ? { lastInboundAt: opts.lastInboundAt } : {}) })),
      update: jest.fn(async (a: any) => void calls.convUpdate.push(a)),
    },
    waMessage: {
      create: jest.fn(async (a: any) => {
        if (opts.duplicate) throw new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" });
        calls.msgCreate.push(a);
      }),
    },
    messageEvent: {
      findFirst: jest.fn(async () => opts.evento ?? null),
      update: jest.fn(async (a: any) => void calls.eventoUpdate.push(a)),
    },
  };
  return { prisma, calls };
}

const msg = (over: any = {}) => ({
  phoneNumberId: "1055", waId: "5584999998888", contactName: "Maria", wamid: "wamid.A", timestamp: new Date("2026-10-10T12:00:00Z"),
  type: "text", body: "Oi", mediaId: null, mediaMime: null, mediaFilename: null, ...over,
});

describe("storeInboundMessage", () => {
  beforeEach(() => jest.clearAllMocks());

  it("grava a mensagem, liga ao cliente e conta como não lida", async () => {
    const { prisma, calls } = makeFake({ client: { id: "c1", nome: "Maria" } });
    const r = await storeInboundMessage(prisma, "t1", "acc1", msg());
    expect(r).toMatchObject({ stored: true, clientId: "c1", optedOut: false });
    expect(calls.msgCreate[0].data).toMatchObject({ tenantId: "t1", direction: "ENTRADA", wamid: "wamid.A", body: "Oi" });
    expect(calls.convUpdate[0].data.unreadCount).toEqual({ increment: 1 });
  });

  it("mensagem duplicada (a Meta reenviou) não conta de novo", async () => {
    const { prisma, calls } = makeFake({ duplicate: true });
    const r = await storeInboundMessage(prisma, "t1", "acc1", msg());
    expect(r.stored).toBe(false);
    expect(calls.convUpdate).toHaveLength(0);
  });

  it("telefone desconhecido cria a conversa sem cliente", async () => {
    const { prisma } = makeFake();
    const r = await storeInboundMessage(prisma, "t1", "acc1", msg());
    expect(r.clientId).toBeNull();
    expect(prisma.messageEvent.findFirst).not.toHaveBeenCalled();
  });

  it("resposta a uma campanha marca o envio como respondido", async () => {
    const { prisma, calls } = makeFake({ client: { id: "c1" }, evento: { id: "ev1" } });
    await storeInboundMessage(prisma, "t1", "acc1", msg());
    expect(calls.eventoUpdate[0]).toMatchObject({ where: { id: "ev1" }, data: { status: "RESPONDIDO" } });
  });

  it("PARAR de cliente conhecido registra opt-out e auditoria", async () => {
    const { prisma, calls } = makeFake({ client: { id: "c1" } });
    const r = await storeInboundMessage(prisma, "t1", "acc1", msg({ body: "PARAR" }));
    expect(r.optedOut).toBe(true);
    expect(calls.clientUpdate[0]).toMatchObject({ where: { id: "c1", tenantId: "t1" }, data: { autorizacaoComunicacao: false } });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "OPT_OUT_WHATSAPP", targetId: "c1" }));
  });

  it("PARAR de número desconhecido não mexe em nenhum cliente", async () => {
    const { prisma, calls } = makeFake();
    const r = await storeInboundMessage(prisma, "t1", "acc1", msg({ body: "parar" }));
    expect(r.optedOut).toBe(false);
    expect(calls.clientUpdate).toHaveLength(0);
  });

  it("mensagem mais antiga que a última não sobrescreve o resumo da conversa", async () => {
    const { prisma, calls } = makeFake({ lastInboundAt: new Date("2026-10-10T13:00:00Z") });
    await storeInboundMessage(prisma, "t1", "acc1", msg());
    expect(calls.convUpdate[0].data.lastPreview).toBeUndefined();
  });
});

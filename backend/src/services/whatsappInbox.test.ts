import { Prisma } from "@prisma/client";
import { storeInboundMessage } from "./whatsappInbox";

jest.mock("../middleware/audit", () => ({ logAudit: jest.fn(async () => undefined) }));
import { logAudit } from "../middleware/audit";

function makeFake(opts: { client?: any; mesmoTelefone?: any[]; duplicate?: boolean; evento?: any; lastInboundAt?: Date | null } = {}) {
  const calls: Record<string, any[]> = { msgCreate: [], convUpdate: [], clientUpdate: [], eventoUpdate: [], recipientUpdate: [], supressao: [] };
  const prisma: any = {
    tenant: { findUnique: jest.fn(async () => ({ cpfSalt: "salt-t1" })) },
    supressaoTitular: {
      findMany: jest.fn(async () => []),
      create: jest.fn(async (a: any) => {
        calls.supressao.push(a);
        return { id: "sup1" };
      }),
    },
    client: {
      findFirst: jest.fn(async () => opts.client ?? null),
      // todos os cadastros do tenant com o mesmo telefone (LGPD 02-03)
      findMany: jest.fn(async () => opts.mesmoTelefone ?? (opts.client ? [{ id: opts.client.id }] : [])),
      updateMany: jest.fn(async (a: any) => void calls.clientUpdate.push(a)),
    },
    conversation: {
      findFirst: jest.fn(async () => null),
      upsert: jest.fn(async ({ create }: any) => ({ ...create, id: "conv1", clientId: opts.client?.id ?? null, ...(opts.lastInboundAt ? { lastInboundAt: opts.lastInboundAt } : {}) })),
      update: jest.fn(async (a: any) => void calls.convUpdate.push(a)),
    },
    waMessage: {
      create: jest.fn(async (a: any) => {
        if (opts.duplicate) throw new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" });
        calls.msgCreate.push(a);
        return { id: "msg1" };
      }),
    },
    campaignRecipient: { updateMany: jest.fn(async (a: any) => void calls.recipientUpdate.push(a)) },
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
    expect(r).toMatchObject({ stored: true, messageId: "msg1", clientId: "c1", optedOut: false });
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
    // só procura o envio por destinatário de lista manual (telefone), nunca por cliente
    expect((prisma.messageEvent.findFirst as jest.Mock).mock.calls[0][0].where).toHaveProperty("recipient");
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
    expect(calls.clientUpdate[0]).toMatchObject({ where: { id: { in: ["c1"] }, tenantId: "t1" }, data: { autorizacaoComunicacao: false } });
    expect(calls.clientUpdate[1]).toMatchObject({ where: { optOutAt: null }, data: { optOutAt: expect.any(Date) } });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "OPT_OUT_WHATSAPP", targetId: "c1" }));
  });

  it("tocar no botão SAIR de um template também descadastra", async () => {
    const { prisma, calls } = makeFake({ client: { id: "c1" } });
    const r = await storeInboundMessage(prisma, "t1", "acc1", msg({ type: "button", body: "SAIR" }));
    expect(r.optedOut).toBe(true);
    expect(calls.clientUpdate.length).toBeGreaterThan(0);
  });

  // LGPD 02-03 (b): antes só o findFirst (o cadastro mais recente) era marcado
  it("PARAR marca opt-out em TODOS os cadastros com o mesmo telefone, nas duas formas do nono dígito", async () => {
    const { prisma, calls } = makeFake({ client: { id: "c1" }, mesmoTelefone: [{ id: "c1" }, { id: "c2-cnpj" }] });
    await storeInboundMessage(prisma, "t1", "acc1", msg({ waId: "558499998888", body: "Parar" }));
    const busca = (prisma.client.findMany as jest.Mock).mock.calls[0][0].where;
    expect(busca).toMatchObject({ tenantId: "t1" });
    expect(busca.telefone.in).toEqual(expect.arrayContaining(["+5584999998888", "+558499998888"]));
    expect(calls.clientUpdate.every((u) => JSON.stringify(u.where.id.in) === JSON.stringify(["c1", "c2-cnpj"]))).toBe(true);
  });

  // LGPD 02-03 (a): o pedido vale pelo telefone e sobrevive à reimportação/anonimização (SupressaoTitular)
  it("PARAR grava a supressão do telefone (hash, nunca o número), com ou sem cliente", async () => {
    for (const client of [{ id: "c1" }, undefined]) {
      const { prisma, calls } = makeFake({ client });
      await storeInboundMessage(prisma, "t1", "acc1", msg({ body: "PARAR" }));
      expect(calls.supressao).toHaveLength(1);
      const data = calls.supressao[0].data;
      expect(data).toMatchObject({ tenantId: "t1", motivo: "OPT_OUT", canal: "WHATSAPP" });
      expect(data.phoneHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(data)).not.toContain("99998888");
    }
  });

  it("PARAR de número fora da base não mexe em cliente, mas bloqueia o contato nas próximas listas", async () => {
    const { prisma, calls } = makeFake();
    const r = await storeInboundMessage(prisma, "t1", "acc1", msg({ body: "parar" }));
    expect(r.optedOut).toBe(true);
    expect(calls.clientUpdate).toHaveLength(0);
    expect(calls.recipientUpdate[0].where).toMatchObject({ tenantId: "t1", optOutAt: null });
    expect(calls.recipientUpdate[0].data.optOutAt).toBeInstanceOf(Date);
  });

  // LGPD 02-04: frases usuais (não só a palavra exata)
  it("'Me tira dessa lista, por favor' também é descadastro", async () => {
    const { prisma, calls } = makeFake({ client: { id: "c1" } });
    const r = await storeInboundMessage(prisma, "t1", "acc1", msg({ body: "Me tira dessa lista, por favor" }));
    expect(r.optedOut).toBe(true);
    expect(calls.supressao).toHaveLength(1);
  });

  it("mensagem comum não descadastra", async () => {
    const { prisma, calls } = makeFake({ client: { id: "c1" } });
    const r = await storeInboundMessage(prisma, "t1", "acc1", msg({ body: "Oi, quero saber meu limite" }));
    expect(r.optedOut).toBe(false);
    expect(calls.supressao).toHaveLength(0);
    expect(calls.clientUpdate).toHaveLength(0);
  });

  it("mensagem mais antiga que a última não sobrescreve o resumo da conversa", async () => {
    const { prisma, calls } = makeFake({ lastInboundAt: new Date("2026-10-10T13:00:00Z") });
    await storeInboundMessage(prisma, "t1", "acc1", msg());
    expect(calls.convUpdate[0].data.lastPreview).toBeUndefined();
  });
});

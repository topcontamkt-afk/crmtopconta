/**
 * Fila de campanha: grupo de controle e dedupe (Prisma falso em memória — ver retention.test.ts
 * para o mesmo padrão; não há banco real neste repo).
 */
import { buildAudience, enqueueCampaign, hasRealWhatsApp, processQueueBatch, resolveWhatsAppTemplate } from "./campaignQueue";
import { phoneHash } from "./privacy";

function makeFakePrisma(campaign: Record<string, unknown>, clientCount: number) {
  const created: any[] = [];
  const dedupeWheres: any[] = [];
  const clients = Array.from({ length: clientCount }, (_, i) => ({ id: `c${i}` }));
  const prisma: any = {
    campaign: {
      findUniqueOrThrow: jest.fn(async () => ({
        id: "camp1",
        channel: "WHATSAPP",
        messageTemplate: "Olá {{nome}}",
        dedupeWindowHrs: 72,
        variantSplitPercent: null,
        controlGroupPercent: null,
        segment: null,
        adHocFilters: null,
        ...campaign,
      })),
      update: jest.fn(async () => ({})),
    },
    client: { findMany: jest.fn(async () => clients) },
    tenant: { findUnique: jest.fn(async () => ({ baseLegalMarketing: "LEGITIMO_INTERESSE" })) },
    messageEvent: {
      findFirst: jest.fn(async ({ where }: any) => {
        dedupeWheres.push(where);
        return null;
      }),
      create: jest.fn(async ({ data }: any) => {
        created.push(data);
        return data;
      }),
    },
  };
  return { prisma, created, dedupeWheres };
}

describe("enqueueCampaign — grupo de controle", () => {
  afterEach(() => jest.restoreAllMocks());

  it("desligado por padrão: todo o público vai para a fila, ninguém vira controle", async () => {
    const { prisma, created } = makeFakePrisma({}, 5);
    const r = await enqueueCampaign(prisma, "t1", "camp1");
    expect(r).toMatchObject({ queued: 5, control: 0 });
    expect(created.every((e) => e.status === "FILA")).toBe(true);
  });

  it("com % de controle: parte do público vira CONTROLE (não vai para a fila de envio)", async () => {
    // sorteios por cliente: 0.1, 0.5, 0.15, 0.9 → com 20%, c0 e c2 são controle
    const draws = [0.1, 0.5, 0.15, 0.9];
    let i = 0;
    jest.spyOn(Math, "random").mockImplementation(() => draws[i++ % draws.length]);

    const { prisma, created } = makeFakePrisma({ controlGroupPercent: 20 }, 4);
    const r = await enqueueCampaign(prisma, "t1", "camp1");

    expect(r).toMatchObject({ queued: 2, control: 2 });
    expect(created.filter((e) => e.status === "CONTROLE").map((e) => e.clientId)).toEqual(["c0", "c2"]);
    expect(created.filter((e) => e.status === "FILA").map((e) => e.clientId)).toEqual(["c1", "c3"]);
  });

  it("o público total da campanha inclui o controle", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0); // todos no controle
    const { prisma } = makeFakePrisma({ controlGroupPercent: 10 }, 3);
    await enqueueCampaign(prisma, "t1", "camp1");
    expect(prisma.campaign.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ audienceCount: 3 }) })
    );
  });

  it("o sorteio do controle vem antes do A/B: quem é controle não consome sorteio de variante", async () => {
    // c0: controle (0.05 < 20). c1: não controle (0.9), depois variante (0.3 < 50 → B)
    const draws = [0.05, 0.9, 0.3];
    let i = 0;
    jest.spyOn(Math, "random").mockImplementation(() => draws[i++]);
    const { prisma, created } = makeFakePrisma({ controlGroupPercent: 20, variantSplitPercent: 50 }, 2);
    await enqueueCampaign(prisma, "t1", "camp1");
    expect(created[0]).toMatchObject({ clientId: "c0", status: "CONTROLE" });
    expect(created[1]).toMatchObject({ clientId: "c1", status: "FILA", variant: "B" });
  });

  it("quem ficou no controle de uma campanha anterior não bloqueia o dedupe (não recebeu mensagem)", async () => {
    const { prisma, dedupeWheres } = makeFakePrisma({}, 1);
    await enqueueCampaign(prisma, "t1", "camp1");
    expect(dedupeWheres[0].status).toEqual({ not: "CONTROLE" });
  });
});

describe("enqueueCampaign — público enviável", () => {
  it("nunca inclui cliente sem limite (comércio credenciado) no público", async () => {
    const { prisma } = makeFakePrisma({}, 2);
    await enqueueCampaign(prisma, "t1", "camp1");
    const where = prisma.client.findMany.mock.calls[0][0].where;
    expect(where.limiteTotal).toEqual({ gt: 0 });
  });
});

describe("resolveWhatsAppTemplate — WhatsApp real só envia template aprovado pela Meta", () => {
  const real: any = [{ name: "whatsapp_cloud_api", adapter: {} }];
  const mock: any = [{ name: "mock", adapter: {} }];
  const camp = { tenantId: "t1", channel: "WHATSAPP", templateId: "tp1" };
  const prismaWith = (tpl: any): any => ({ messageTemplate: { findFirst: jest.fn(async () => tpl) } });
  const aprovado = { id: "tp1", channel: "WHATSAPP", name: "Oferta", status: "APROVADO", metaStatus: "APPROVED", metaName: "oferta_v1" };

  it("template aprovado de verdade é usado", async () => {
    const r = await resolveWhatsAppTemplate(prismaWith(aprovado), camp, real);
    expect(r.template).toBe(aprovado);
    expect(r.bloqueado).toBeUndefined();
  });
  it("sem template e com provedor real: bloqueia", async () => {
    const r = await resolveWhatsAppTemplate(prismaWith(null), { ...camp, templateId: null }, real);
    expect(r.bloqueado).toContain("template aprovado");
  });
  it("template ainda em análise na Meta: bloqueia e diz o status", async () => {
    const r = await resolveWhatsAppTemplate(prismaWith({ ...aprovado, status: "PENDENTE_APROVACAO", metaStatus: "PENDING" }), camp, real);
    expect(r.bloqueado).toContain("PENDING");
  });
  it("marcado como aprovado mas sem registro na Meta também bloqueia", async () => {
    const r = await resolveWhatsAppTemplate(prismaWith({ ...aprovado, metaName: null, metaStatus: null }), camp, real);
    expect(r.bloqueado).toBeDefined();
  });
  it("sem provedor real (mock/dev) mantém o texto livre", async () => {
    const r = await resolveWhatsAppTemplate(prismaWith(null), { ...camp, templateId: null }, mock);
    expect(r).toEqual({ template: null });
  });
  it("SMS não passa por template da Meta", async () => {
    const r = await resolveWhatsAppTemplate(prismaWith(null), { ...camp, channel: "SMS" }, real);
    expect(r).toEqual({ template: null });
  });
});

/* ------------------------------------------------------------------------------------------------
 * LGPD 02-03: opt-out e supressão conferidos no ENVIO, para todo evento (cliente ou destinatário de lista)
 * ---------------------------------------------------------------------------------------------- */
const SALT = "salt-t1";
const liberado = (over: any = {}) => ({ id: "c1", telefone: "+5584911110000", cpfHash: "doc-c1", nome: "Ana", autorizacaoComunicacao: true, optOutAt: null, bloqueadoLgpdAt: null, limiteTotal: 1000, saldoDisponivel: 500, percentualUtilizado: 50, cidade: "Natal", ...over });

function fakeEnvio(eventos: any[], opts: { supressoes?: any[]; optOutPorTelefone?: string[]; channel?: string } = {}) {
  const updates: any[] = [];
  const prisma: any = {
    campaign: {
      findUniqueOrThrow: jest.fn(async () => ({ id: "camp1", tenantId: "t1", channel: opts.channel ?? "SMS", templateId: null, messageTemplate: "Olá {{nome}}", messageTemplateB: null, throttlePerMin: 100, costPerMessage: 0 })),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 1 })), // trava do disparo (dispatchGuard)
    },
    tenant: {
      findUniqueOrThrow: jest.fn(async () => ({ id: "t1", name: "TopConta", maxMsgsPerMinute: 1000, baseLegalMarketing: "LEGITIMO_INTERESSE" })),
      findUnique: jest.fn(async () => ({ cpfSalt: SALT, whatsappProvider: "META", baseLegalMarketing: "LEGITIMO_INTERESSE" })),
    },
    channelConfig: { findMany: jest.fn(async () => []) },
    whatsAppAccount: { findFirst: jest.fn(async () => null) },
    messageTemplate: { findFirst: jest.fn(async () => null) },
    messageEvent: {
      count: jest.fn(async () => 0),
      // `status` em forma de lista é a consulta "já enviados nesta campanha" (trava de telefone repetido): vazia aqui
      findMany: jest.fn(async ({ where }: any) => (where?.status && typeof where.status === "object" ? [] : eventos)),
      updateMany: jest.fn(async () => ({ count: eventos.length })), // reserva dos itens (dispatchGuard)
      update: jest.fn(async (a: any) => void updates.push(a)),
    },
    supressaoTitular: { findMany: jest.fn(async () => opts.supressoes ?? []) },
    client: { findMany: jest.fn(async ({ where }: any) => (opts.optOutPorTelefone ?? []).filter((t) => where.telefone.in.includes(t)).map((telefone) => ({ telefone }))) },
    campaignRecipient: { findMany: jest.fn(async () => []) },
  };
  const statusDe = (id: string) => updates.find((u) => u.where.id === id)?.data;
  return { prisma, updates, statusDe };
}

describe("processQueueBatch — opt-out/supressão no envio (LGPD 02-03)", () => {
  it("destinatário de lista (sem cliente) que pediu para parar NÃO recebe", async () => {
    const recipient = { id: "r1", nome: "Bia", telefone: "+5584922223333", cpfHash: null, limiteDisponivel: 100, optOutAt: new Date("2026-10-01") };
    const { prisma, statusDe } = fakeEnvio([{ id: "e1", clientId: null, recipientId: "r1", client: null, recipient, variant: "A" }]);
    await processQueueBatch(prisma, "camp1");
    expect(statusDe("e1")).toMatchObject({ status: "BLOQUEADO", error: expect.stringContaining("opt-out") });
  });

  it("telefone suprimido (SupressaoTitular) bloqueia, na forma sem o nono dígito também", async () => {
    const recipient = { id: "r1", nome: "Bia", telefone: "+558488887777", cpfHash: null, limiteDisponivel: 100, optOutAt: null };
    const supressoes = [{ tenantId: "t1", phoneHash: phoneHash(SALT, "+5584988887777"), docHash: null, motivo: "OPT_OUT" }];
    const { prisma, statusDe } = fakeEnvio([{ id: "e1", clientId: null, recipientId: "r1", client: null, recipient, variant: "A" }], { supressoes });
    await processQueueBatch(prisma, "camp1");
    expect(statusDe("e1")).toMatchObject({ status: "BLOQUEADO" });
  });

  it("o mesmo telefone em OUTRO cadastro com opt-out bloqueia o cliente liberado", async () => {
    const { prisma, statusDe } = fakeEnvio([{ id: "e1", clientId: "c1", client: liberado(), recipient: null, variant: "A" }], { optOutPorTelefone: ["+5584911110000"] });
    await processQueueBatch(prisma, "camp1");
    expect(statusDe("e1")).toMatchObject({ status: "BLOQUEADO" });
  });

  it("documento suprimido (eliminação) bloqueia", async () => {
    const supressoes = [{ tenantId: "t1", phoneHash: null, docHash: "doc-c1", motivo: "ELIMINACAO" }];
    const { prisma, statusDe } = fakeEnvio([{ id: "e1", clientId: "c1", client: liberado(), recipient: null, variant: "A" }], { supressoes });
    await processQueueBatch(prisma, "camp1");
    expect(statusDe("e1")).toMatchObject({ status: "BLOQUEADO" });
  });

  it("tratamento bloqueado a pedido do titular (bloqueadoLgpdAt) bloqueia", async () => {
    const { prisma, statusDe } = fakeEnvio([{ id: "e1", clientId: "c1", client: liberado({ bloqueadoLgpdAt: new Date() }), recipient: null, variant: "A" }]);
    await processQueueBatch(prisma, "camp1");
    expect(statusDe("e1")).toMatchObject({ status: "BLOQUEADO", error: expect.stringContaining("bloqueado") });
  });

  it("contato liberado é enviado; a supressão é consultada uma vez para o lote todo", async () => {
    const eventos = [1, 2, 3].map((i) => ({ id: `e${i}`, clientId: `c${i}`, client: liberado({ id: `c${i}`, telefone: `+558491111000${i}`, cpfHash: `doc${i}` }), recipient: null, variant: "A" }));
    const { prisma, statusDe } = fakeEnvio(eventos);
    await processQueueBatch(prisma, "camp1");
    expect(eventos.map((e) => statusDe(e.id)?.status)).toEqual(["ENVIADO", "ENVIADO", "ENVIADO"]);
    // uma consulta por coluna (telefone e documento) para o lote todo, não uma por mensagem
    expect(prisma.supressaoTitular.findMany).toHaveBeenCalledTimes(2);
  });
});

describe("enqueueManualCampaign — lista refiltrada ao agendar (LGPD 02-03)", () => {
  it("quem pediu para parar depois de criada a lista entra como BLOQUEADO, não na fila", async () => {
    const created: any[] = [];
    const prisma: any = {
      campaign: { findUniqueOrThrow: jest.fn(async () => ({ id: "camp1", manual: true, channel: "WHATSAPP" })), update: jest.fn(async () => ({})) },
      campaignRecipient: {
        findMany: jest.fn(async ({ where }: any) =>
          where.campaignId
            ? [
                { id: "r1", clientId: null, telefone: "+5584922223333", cpfHash: null, optOutAt: new Date(), client: null, messageEvents: [] },
                { id: "r2", clientId: "c2", telefone: "+5584933334444", cpfHash: null, optOutAt: null, client: { autorizacaoComunicacao: false, optOutAt: new Date(), bloqueadoLgpdAt: null, cpfHash: "d2" }, messageEvents: [] },
                { id: "r3", clientId: null, telefone: "+5584944445555", cpfHash: null, optOutAt: null, client: null, messageEvents: [] },
                { id: "r4", clientId: null, telefone: "+5584955556666", cpfHash: null, optOutAt: null, client: null, messageEvents: [] },
              ]
            : []
        ),
      },
      tenant: { findUnique: jest.fn(async () => ({ cpfSalt: SALT, baseLegalMarketing: "LEGITIMO_INTERESSE" })) },
      supressaoTitular: { findMany: jest.fn(async () => [{ tenantId: "t1", phoneHash: phoneHash(SALT, "+5584944445555"), docHash: null, motivo: "OPT_OUT" }]) },
      client: { findMany: jest.fn(async () => []) },
      messageEvent: { createMany: jest.fn(async ({ data }: any) => void created.push(...data)) },
    };
    const r: any = await enqueueCampaign(prisma, "t1", "camp1");
    const st = Object.fromEntries(created.map((e) => [e.recipientId, e.status]));
    expect(st).toEqual({ r1: "BLOQUEADO", r2: "BLOQUEADO", r3: "BLOQUEADO", r4: "FILA" });
    expect(r).toMatchObject({ queued: 1, bloqueados: 3 });
  });
});

describe("buildAudience — público exclui bloqueio e supressão (LGPD 02-03)", () => {
  it("filtra bloqueadoLgpdAt no banco e tira telefones suprimidos depois", async () => {
    const prisma: any = {
      campaign: { findUniqueOrThrow: jest.fn(async () => ({ id: "camp1", segment: null, adHocFilters: null })) },
      client: {
        findMany: jest.fn(async ({ where }: any) =>
          where.optOutAt?.not !== undefined ? [] : [liberado({ id: "a", telefone: "+5584988881111" }), liberado({ id: "b", telefone: "+5584933334444", cpfHash: "doc-b" })]
        ),
      },
      tenant: { findUnique: jest.fn(async () => ({ cpfSalt: SALT })) },
      supressaoTitular: { findMany: jest.fn(async () => [{ tenantId: "t1", phoneHash: phoneHash(SALT, "+558488881111"), docHash: null, motivo: "OPT_OUT" }]) },
      campaignRecipient: { findMany: jest.fn(async () => []) },
    };
    const r = await buildAudience(prisma, "t1", "camp1");
    expect(r.map((c: any) => c.id)).toEqual(["b"]);
    expect(prisma.client.findMany.mock.calls[0][0].where).toMatchObject({ autorizacaoComunicacao: true, optOutAt: null, bloqueadoLgpdAt: null });
  });
});

/* ------------------------------------------------------------------------------------------------
 * LGPD 06-01: sem provedor do próprio tenant não há envio pela credencial global do ambiente
 * ---------------------------------------------------------------------------------------------- */
describe("provedores do tenant (LGPD 06-01)", () => {
  const OLD = { ...process.env };
  beforeEach(() => {
    delete process.env.MESSAGING_MODE;
    process.env.TWILIO_ACCOUNT_SID = "AC_GLOBAL";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    process.env.TWILIO_FROM_NUMBER = "+15550000000";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "PN_GLOBAL";
    process.env.WHATSAPP_ACCESS_TOKEN = "EAAG_GLOBAL";
    delete process.env.ALLOW_GLOBAL_CHANNEL_CREDENTIALS;
    delete process.env.PLATFORM_DEFAULT_TENANT_ID;
  });
  afterAll(() => {
    process.env = OLD;
  });

  it("sem MESSAGING_MODE=mock, tenant sem canal próprio: disparo bloqueado com aviso claro, fila intacta, nada pela conta global", async () => {
    const fetchSpy = jest.spyOn(global, "fetch" as any).mockImplementation(async () => {
      throw new Error("não deveria chamar a rede");
    });
    const { prisma, updates } = fakeEnvio([{ id: "e1", clientId: "c1", client: liberado(), recipient: null, variant: "A" }]);
    const r: any = await processQueueBatch(prisma, "camp1");
    expect(r.bloqueado).toMatch(/configure o canal do tenant/i);
    expect(r.processed).toBe(0);
    expect(updates).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("WhatsApp: credencial do ambiente só para o tenant dono (PLATFORM_DEFAULT_TENANT_ID)", async () => {
    const prisma: any = {
      tenant: { findUnique: jest.fn(async () => ({ whatsappProvider: "META" })) },
      channelConfig: { findMany: jest.fn(async () => []) },
      whatsAppAccount: { findFirst: jest.fn(async () => null) },
    };
    expect(await hasRealWhatsApp(prisma, "tA")).toBe(false);
    process.env.PLATFORM_DEFAULT_TENANT_ID = "tA";
    expect(await hasRealWhatsApp(prisma, "tA")).toBe(true);
    expect(await hasRealWhatsApp(prisma, "tB")).toBe(false);
  });

  it("ALLOW_GLOBAL_CHANNEL_CREDENTIALS=true (dev) libera a reserva para qualquer tenant", async () => {
    process.env.ALLOW_GLOBAL_CHANNEL_CREDENTIALS = "true";
    const prisma: any = {
      tenant: { findUnique: jest.fn(async () => ({ whatsappProvider: "META" })) },
      channelConfig: { findMany: jest.fn(async () => []) },
      whatsAppAccount: { findFirst: jest.fn(async () => null) },
    };
    expect(await hasRealWhatsApp(prisma, "tB")).toBe(true);
  });

  it("MESSAGING_MODE=mock, sem nada configurado, cai no mock (só simula)", async () => {
    process.env.MESSAGING_MODE = "mock";
    const { prisma, statusDe } = fakeEnvio([{ id: "e1", clientId: "c1", client: liberado(), recipient: null, variant: "A" }]);
    await processQueueBatch(prisma, "camp1");
    expect(statusDe("e1")).toMatchObject({ status: "ENVIADO", provider: "mock" });
  });
});

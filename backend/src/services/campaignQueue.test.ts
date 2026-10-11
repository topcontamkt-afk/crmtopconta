/**
 * Fila de campanha: grupo de controle e dedupe (Prisma falso em memória — ver retention.test.ts
 * para o mesmo padrão; não há banco real neste repo).
 */
import { enqueueCampaign, resolveWhatsAppTemplate } from "./campaignQueue";

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

/**
 * Lote 4 da adequação LGPD no envio: base legal declarada (02-01) e rodapé do controlador no texto livre
 * (02-05: SMS e WhatsApp sem template da Meta; 02-07: Z-API). Prisma falso, como em campaignQueue.test.ts.
 */
const zapiEnviados: { to: string; body: string }[] = [];
jest.mock("./channels/zapi", () => ({
  ZAPI_BATCH_MAX: 4,
  ZapiAdapter: class {
    channel = "WHATSAPP";
    async send(to: string, body: string) {
      zapiEnviados.push({ to, body });
      return { providerMessageId: "zapi-1", status: "SENT" };
    }
  },
}));
jest.mock("./zapi", () => ({ zapiCredentialsOf: () => ({ instanceId: "i", token: "t" }) }));

import { enqueueCampaign, processQueueBatch, sendTestMessages } from "./campaignQueue";
import { MockSMSAdapter } from "./channels/sms";
import { SEM_BASE_LEGAL } from "./baseLegal";
import { AVISO_RENDA_IGNORADA } from "./segments";

const SALT = "salt-t1";
const cliente = { id: "c1", telefone: "+5584911110000", cpfHash: "doc-c1", nome: "Ana", autorizacaoComunicacao: true, optOutAt: null, bloqueadoLgpdAt: null, limiteTotal: 1000, saldoDisponivel: 500, percentualUtilizado: 50, cidade: "Natal" };

function fake(opts: { base?: string | null; provider?: "META" | "ZAPI"; channel?: string; tenant?: Record<string, unknown>; campanha?: Record<string, unknown> } = {}) {
  const updates: any[] = [];
  const tenant = {
    id: "t1",
    name: "TopConta",
    maxMsgsPerMinute: 1000,
    cpfSalt: SALT,
    whatsappProvider: opts.provider ?? "META",
    baseLegalMarketing: opts.base === undefined ? "LEGITIMO_INTERESSE" : opts.base,
    controladorNome: null,
    rodapeOptOut: null,
    ...opts.tenant,
  };
  const prisma: any = {
    campaign: {
      findUniqueOrThrow: jest.fn(async () => ({ id: "camp1", tenantId: "t1", channel: opts.channel ?? "SMS", templateId: null, messageTemplate: "Olá {{nome}}, seu limite renovou.", messageTemplateB: null, throttlePerMin: 100, costPerMessage: 0, baseLegal: null, manual: false, segment: null, adHocFilters: null, dedupeWindowHrs: 72, ...opts.campanha })),
      update: jest.fn(async () => ({})),
    },
    tenant: { updateMany: jest.fn(async () => ({ count: 1 })), /* trava do disparo (dispatchGuard) */ findUniqueOrThrow: jest.fn(async () => tenant), findUnique: jest.fn(async () => tenant) },
    channelConfig: { findMany: jest.fn(async () => []) },
    whatsAppAccount: { findFirst: jest.fn(async () => ({ id: "z1", provider: "ZAPI" })) },
    messageTemplate: { findFirst: jest.fn(async () => null) },
    messageEvent: {
      count: jest.fn(async () => 1),
      // `status` em forma de lista é a consulta "já enviados nesta campanha" (trava de telefone repetido): vazia aqui
      findMany: jest.fn(async ({ where }: any) => (where?.status && typeof where.status === "object" ? [] : [{ id: "e1", clientId: "c1", client: cliente, recipient: null, variant: "A" }])),
      updateMany: jest.fn(async () => ({ count: 1 })), // reserva dos itens (dispatchGuard)
      findFirst: jest.fn(async () => null),
      create: jest.fn(async () => ({})),
      update: jest.fn(async (a: any) => void updates.push(a)),
    },
    supressaoTitular: { findMany: jest.fn(async () => []) },
    client: { findMany: jest.fn(async ({ where }: any) => (where.optOutAt?.not !== undefined ? [] : [cliente])) },
    campaignRecipient: { findMany: jest.fn(async () => []) },
  };
  return { prisma, updates };
}

beforeEach(() => {
  zapiEnviados.length = 0;
  jest.restoreAllMocks();
});

describe("LGPD 02-01: sem base legal declarada, nada é enfileirado nem enviado", () => {
  it("processQueueBatch bloqueia com a mensagem de Configurações → LGPD e não mexe na fila", async () => {
    const send = jest.spyOn(MockSMSAdapter.prototype, "send");
    const { prisma, updates } = fake({ base: null });
    const r: any = await processQueueBatch(prisma, "camp1");
    expect(r.bloqueado).toBe(SEM_BASE_LEGAL);
    expect(r.bloqueado).toContain("Configurações → LGPD");
    expect(r).toMatchObject({ processed: 0, remaining: 1 });
    expect(updates).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("valor desconhecido na base também bloqueia", async () => {
    const { prisma } = fake({ base: "ACHO_QUE_PODE" });
    expect(((await processQueueBatch(prisma, "camp1")) as any).bloqueado).toBe(SEM_BASE_LEGAL);
  });

  it("enqueueCampaign (campanha, lista manual e automação) não cria evento sem base", async () => {
    const { prisma } = fake({ base: null });
    const r = await enqueueCampaign(prisma, "t1", "camp1");
    expect(r).toMatchObject({ queued: 0, bloqueado: SEM_BASE_LEGAL });
    expect(prisma.messageEvent.create).not.toHaveBeenCalled();
    expect(prisma.campaign.update).not.toHaveBeenCalled();
  });

  it("LGPD 01-03: segmento antigo com filtro de renda não é enfileirado (o público seria maior)", async () => {
    const { prisma } = fake({ campanha: { segment: { filters: { perfilRenda: ["PF1"] } } } });
    const r = await enqueueCampaign(prisma, "t1", "camp1");
    expect(r).toMatchObject({ queued: 0, bloqueado: AVISO_RENDA_IGNORADA });
    expect(prisma.client.findMany).not.toHaveBeenCalled();
    expect(prisma.messageEvent.create).not.toHaveBeenCalled();
  });

  it("com base declarada, o disparo grava a base vigente na campanha que ainda não a tinha", async () => {
    const { prisma } = fake({ base: "CONSENTIMENTO" });
    await processQueueBatch(prisma, "camp1");
    expect(prisma.campaign.update).toHaveBeenCalledWith({ where: { id: "camp1" }, data: { baseLegal: "CONSENTIMENTO" } });
  });
});

describe("LGPD 02-05 / 02-07: rodapé do controlador no texto livre", () => {
  it("SMS leva a identificação do controlador e a instrução de SAIR", async () => {
    const send = jest.spyOn(MockSMSAdapter.prototype, "send");
    const { prisma, updates } = fake();
    await processQueueBatch(prisma, "camp1");
    expect(updates[0].data.status).toBe("ENVIADO");
    expect(send.mock.calls[0][1]).toBe("Olá Ana, seu limite renovou.\n\nTopConta: Responda SAIR para não receber mais mensagens.");
  });

  it("rodapé próprio do tenant (Configurações → LGPD) é usado, com o nome do controlador", async () => {
    const send = jest.spyOn(MockSMSAdapter.prototype, "send");
    const { prisma } = fake({ tenant: { controladorNome: "Top Conta Pagamentos", rodapeOptOut: "Para sair da lista, responda SAIR." } });
    await processQueueBatch(prisma, "camp1");
    expect(send.mock.calls[0][1]).toMatch(/\n\nTop Conta Pagamentos: Para sair da lista, responda SAIR\.$/);
  });

  it("Z-API: o texto enviado leva o rodapé (antes ia só o corpo do template)", async () => {
    const { prisma } = fake({ provider: "ZAPI", channel: "WHATSAPP", campanha: { templateId: "tp1" } });
    await processQueueBatch(prisma, "camp1");
    expect(zapiEnviados).toHaveLength(1);
    expect(zapiEnviados[0].body).toContain("Olá Ana, seu limite renovou.");
    expect(zapiEnviados[0].body).toContain("TopConta: Responda SAIR para não receber mais mensagens.");
  });

  it("envio de teste mostra o mesmo rodapé", async () => {
    const { prisma } = fake();
    const r = await sendTestMessages(prisma, "t1", "camp1", ["+5584900001111"]);
    expect(r.body).toContain("TopConta: Responda SAIR");
  });
});

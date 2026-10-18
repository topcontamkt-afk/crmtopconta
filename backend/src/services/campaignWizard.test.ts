jest.mock("../config/db", () => ({ prisma: {}, tenantRaw: { query: jest.fn(async () => [{ ultima: new Date() }]), execute: jest.fn() } }));
jest.mock("./campaignQueue", () => ({ hasRealWhatsApp: jest.fn(async () => true) }));
const prepareManual = jest.fn();
jest.mock("./manualCampaign", () => ({ prepareManual: (...a: any[]) => prepareManual(...a) }));

import { validateWizard } from "./campaignWizard";

/**
 * Lote 4 LGPD no assistente de campanha: base legal (02-01), rodapé/descadastro (02-05, 02-07) e consentimento
 * declarado para quem não é cliente (02-02). O passo "Validação" só lê; o erro impede o lançamento.
 */
const aprovado = { id: "tp1", name: "Oferta", channel: "WHATSAPP", status: "APROVADO", metaStatus: "APPROVED", category: "MARKETING", origin: "LOCAL", footer: "Responda SAIR para não receber mais", quickReplies: [], buttons: [], variableMap: null, sendIssue: null, headerFormat: null, media: null, body: "Olá {{nome}}!" };

function fakePrisma(tenant: Record<string, unknown> = {}, template: Record<string, unknown> = {}) {
  return {
    messageTemplate: { findFirst: jest.fn(async () => ({ ...aprovado, ...template })) },
    tenant: {
      findUniqueOrThrow: jest.fn(async () => ({
        name: "TopConta", custoMarketingUsd: null, custoUtilidadeUsd: null, cambioUsdBrl: null, cpfSalt: "s", whatsappProvider: "META",
        baseLegalMarketing: "LEGITIMO_INTERESSE", liaVersao: "v1", liaAprovadaEm: new Date("2026-10-01"), controladorNome: null, rodapeOptOut: null,
        ...tenant,
      })),
    },
    client: { count: jest.fn(async () => 10), findMany: jest.fn(async () => []) },
    messageEvent: { findMany: jest.fn(async () => []) },
    segmentDefinition: { findFirst: jest.fn() },
  } as any;
}
const todos = { templateId: "tp1", audience: { tipo: "todos" as const } };
const check = (v: any, id: string) => v.checks.find((c: any) => c.id === id);

describe("LGPD 02-01: base legal no assistente", () => {
  it("sem base declarada: erro e não pode lançar", async () => {
    const v = await validateWizard(fakePrisma({ baseLegalMarketing: null }), "t1", todos);
    expect(check(v, "base_legal")).toMatchObject({ nivel: "erro" });
    expect(check(v, "base_legal").detalhe).toContain("Configurações → LGPD");
    expect(v.podeLancar).toBe(false);
  });

  it("legítimo interesse sem LIA aprovada: aviso (o envio segue)", async () => {
    const v = await validateWizard(fakePrisma({ liaVersao: null, liaAprovadaEm: null }), "t1", todos);
    expect(check(v, "base_legal")).toMatchObject({ nivel: "aviso" });
    expect(v.podeLancar).toBe(true);
  });

  it("base e LIA em dia: ok", async () => {
    const v = await validateWizard(fakePrisma(), "t1", todos);
    expect(check(v, "base_legal")).toMatchObject({ nivel: "ok" });
  });

  it("o público elegível exclui o tratamento bloqueado a pedido do titular (LGPD 03-04)", async () => {
    const prisma = fakePrisma();
    await validateWizard(prisma, "t1", todos);
    expect(prisma.client.count.mock.calls[1][0].where).toMatchObject({ bloqueadoLgpdAt: null, optOutAt: null, autorizacaoComunicacao: true });
  });
});

describe("LGPD 02-05 / 02-07: descadastro na mensagem", () => {
  it("template importado da Meta sem rodapé nem botão SAIR: aviso", async () => {
    const v = await validateWizard(fakePrisma({}, { origin: "META", footer: null, quickReplies: [] }), "t1", todos);
    expect(check(v, "rodape")).toMatchObject({ nivel: "aviso" });
    expect(check(v, "rodape").detalhe).toContain("Meta");
  });

  it("template com rodapé de saída: sem aviso", async () => {
    const v = await validateWizard(fakePrisma(), "t1", todos);
    expect(check(v, "rodape")).toBeUndefined();
  });

  it("Z-API: avisa que o rodapé do controlador vai no texto", async () => {
    const v = await validateWizard(fakePrisma({ whatsappProvider: "ZAPI" }, { footer: null }), "t1", todos);
    expect(check(v, "rodape").detalhe).toContain("TopConta: Responda SAIR");
  });
});

describe("LGPD 02-02: lista com quem não é cliente", () => {
  it("conta quem está fora da base e avisa que o consentimento será pedido", async () => {
    prepareManual.mockResolvedValue({ enviar: [{}, {}, {}], daBase: 1, rejected: [], template: aprovado });
    const v = await validateWizard(fakePrisma(), "t1", { templateId: "tp1", audience: { tipo: "planilha", rows: [{ nome: "A", telefone: "1" }] } as any });
    expect(v.foraDaBase).toBe(2);
    expect(check(v, "consentimento")).toMatchObject({ nivel: "aviso" });
  });

  it("lista só de clientes: nada a declarar", async () => {
    prepareManual.mockResolvedValue({ enviar: [{}, {}], daBase: 2, rejected: [], template: aprovado });
    const v = await validateWizard(fakePrisma(), "t1", { templateId: "tp1", audience: { tipo: "planilha", rows: [{ nome: "A", telefone: "1" }] } as any });
    expect(v.foraDaBase).toBe(0);
    expect(check(v, "consentimento")).toBeUndefined();
  });
});

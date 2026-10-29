import { pedidoVencido, prazoDoPedido, relatorioContato, relatorioTitular, suboperadoresDe } from "./titular";

describe("LGPD 03-05: prazo dos pedidos", () => {
  it("prazo = recebido + 15 dias", () => {
    expect(prazoDoPedido(new Date("2026-10-01T12:00:00Z")).toISOString()).toBe("2026-10-16T12:00:00.000Z");
  });

  it("vencido só se ABERTO e com prazo passado", () => {
    const agora = new Date("2026-10-20T00:00:00Z");
    const prazoEm = new Date("2026-10-16T00:00:00Z");
    expect(pedidoVencido({ status: "ABERTO", prazoEm }, agora)).toBe(true);
    expect(pedidoVencido({ status: "ATENDIDO", prazoEm }, agora)).toBe(false);
    expect(pedidoVencido({ status: "ABERTO", prazoEm: new Date("2026-10-25T00:00:00Z") }, agora)).toBe(false);
  });
});

describe("LGPD 03-02/03-06: suboperadores", () => {
  it("lista cada provedor uma vez, ignora mock e trata WhatsApp sem provider como Meta", () => {
    const s = suboperadoresDe([
      { provider: "zapi", channel: "WHATSAPP" },
      { provider: "ZAPI", channel: "WHATSAPP" },
      { provider: "mock", channel: "WHATSAPP" },
      { provider: null, channel: "WHATSAPP" },
      { provider: "twilio", channel: "SMS" },
      { provider: null, channel: "SMS" },
    ]);
    expect(s.map((x) => x.nome)).toEqual(["Z-API", "Meta Platforms (WhatsApp Business Cloud API)", "Twilio"]);
  });
});

describe("LGPD 03-02: relatorioTitular", () => {
  function mockPrisma(client: any) {
    const fn = (v: any) => jest.fn(async () => v);
    return {
      client: { findFirst: fn(client) },
      tenant: { findUnique: fn({ name: "TopConta", controladorNome: null, encarregadoNome: "Ana", encarregadoContato: "dpo@x", avisoPrivacidadeUrl: null, baseLegalMarketing: "LEGITIMO_INTERESSE" }) },
      importJob: { findFirst: fn({ source: "csv", formato: "cartoes", nomeArquivo: "base.csv", startedAt: new Date() }) },
      movement: { findMany: fn([{ id: "m1" }]) },
      accountSnapshot: { findMany: fn([]) },
      purchase: { findMany: fn([{ tipo: "Compra à Vista" }]) },
      conversation: { findMany: fn([{ id: "cv1", waId: "5584999998888", contactName: "Maria", status: "ABERTA", createdAt: new Date(), lastMessageAt: new Date(), account: { provider: "ZAPI", displayPhone: "+55 84" } }]) },
      campaignRecipient: { findMany: fn([{ id: "r1", nome: "Maria", telefone: "+5584999998888", campaign: { id: "k", name: "Lista" } }]) },
      pedidoTitular: { findMany: fn([]) },
      auditLog: { findMany: fn([{ action: "UPDATE_CLIENT" }]) },
      messageEvent: { findMany: fn([{ id: "e1", channel: "SMS", provider: "twilio" }]) },
      waMessage: { findMany: fn([{ conversationId: "cv1", direction: "ENTRADA", type: "image", body: null, mediaMime: "image/jpeg" }]) },
    } as any;
  }
  const cliente = { id: "c1", tenantId: "t1", nome: "Maria", telefone: "+5584999998888", cpfHash: "HASH", cpfMasked: "***", origemCliente: "planilha", lastImportJobId: "j1", tags: [{ tag: "vip" }] };

  it("devolve null para cliente fora do tenant", async () => {
    expect(await relatorioTitular(mockPrisma(null), "t1", "c1")).toBeNull();
  });

  it("reúne tudo, sem cpfHash nem binário de mídia, com suboperadores e filtro de tenant", async () => {
    const p = mockPrisma(cliente);
    const r = (await relatorioTitular(p, "t1", "c1"))!;
    expect(r.titular).not.toHaveProperty("cpfHash");
    expect(r.titular).not.toHaveProperty("tenantId");
    // etiquetas (tabela ClientTag no D1) entram no relatório como lista de textos
    expect(r.titular.tags).toEqual(["vip"]);
    expect(r.compras).toHaveLength(1);
    expect(r.registrosAuditoria).toHaveLength(1);
    expect(r.conversas[0].mensagens[0]).toMatchObject({ type: "image", mediaMime: "image/jpeg" });
    expect(r.conversas[0].mensagens[0]).not.toHaveProperty("conversationId");
    expect(r.listasManuais[0]).not.toHaveProperty("id");
    expect(r.compartilhamento.suboperadores.map((s: any) => s.nome)).toEqual(["Twilio", "Z-API"]);
    expect(r.controlador).toMatchObject({ nome: "TopConta", encarregado: "Ana" });
    expect(r.origem.ultimaImportacao).toMatchObject({ nomeArquivo: "base.csv" });

    // nunca lê WaMediaBlob, e toda consulta é por tenant
    expect(p.waMediaBlob).toBeUndefined();
    for (const m of ["accountSnapshot", "purchase", "conversation", "campaignRecipient", "pedidoTitular", "auditLog", "waMessage"]) {
      expect(p[m].findMany.mock.calls[0][0].where.tenantId).toBe("t1");
    }
    expect(p.movement.findMany.mock.calls[0][0].where.client).toEqual({ tenantId: "t1" });
    const me = p.messageEvent.findMany.mock.calls[0][0].where;
    expect(me.campaign).toEqual({ tenantId: "t1" });
    // envios de lista manual ainda não ligados ao cliente entram pelo recipientId
    expect(me.OR).toEqual([{ clientId: "c1" }, { recipientId: { in: ["r1"] } }]);
    expect(p.waMessage.findMany.mock.calls[0][0].select).not.toHaveProperty("mediaId");
  });

  it("listas manuais: pelo número só sem documento ou com o mesmo (número reaproveitado é outra pessoa)", async () => {
    const p = mockPrisma(cliente);
    await relatorioTitular(p, "t1", "c1");
    expect(p.campaignRecipient.findMany.mock.calls[0][0].where).toEqual({
      tenantId: "t1",
      OR: [{ clientId: "c1" }, { cpfHash: "HASH" }, { telefone: "+5584999998888", OR: [{ cpfHash: null }, { cpfHash: "HASH" }] }],
    });
  });
});

describe("LGPD 03-09: relatorioContato (quem não é cliente)", () => {
  it("só registros sem cliente, pelas variantes do número, com tenant em toda consulta e suboperadores", async () => {
    const fn = (v: any) => jest.fn(async () => v);
    const p: any = {
      tenant: { findUnique: fn({ name: "TopConta", controladorNome: null, encarregadoNome: null, encarregadoContato: null, avisoPrivacidadeUrl: null, baseLegalMarketing: null }) },
      campaignRecipient: { findMany: fn([{ id: "r1", nome: "Zé", telefone: "+5584977776666", cpfMasked: null, campaign: { id: "k", name: "Lista" } }]) },
      conversation: { findMany: fn([{ id: "cv", waId: "5584977776666", contactName: "Zé", status: "ABERTA", createdAt: new Date(), lastMessageAt: new Date(), account: { provider: "META", displayPhone: "+55" } }]) },
      messageEvent: { findMany: fn([{ channel: "WHATSAPP", provider: "whatsapp_cloud_api", status: "ENTREGUE" }]) },
      waMessage: { findMany: fn([{ conversationId: "cv", direction: "ENTRADA", type: "text", body: "oi" }]) },
    };
    const r = (await relatorioContato(p, "t1", "(84) 97777-6666"))!;
    const wr = p.campaignRecipient.findMany.mock.calls[0][0].where;
    expect(wr).toMatchObject({ tenantId: "t1", clientId: null });
    expect(wr.telefone.in).toContain("+5584977776666");
    expect(p.conversation.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", clientId: null });
    expect(p.messageEvent.findMany.mock.calls[0][0].where).toEqual({ campaign: { tenantId: "t1" }, recipientId: { in: ["r1"] } });
    expect(r.listasManuais[0]).not.toHaveProperty("id");
    expect(r.conversas[0].mensagens[0]).toEqual({ direction: "ENTRADA", type: "text", body: "oi" });
    expect(r.compartilhamento.suboperadores.map((s: any) => s.nome)).toEqual(["Meta Platforms (WhatsApp Business Cloud API)"]);
    expect(await relatorioContato(p, "t1", "12")).toBeNull();
  });
});


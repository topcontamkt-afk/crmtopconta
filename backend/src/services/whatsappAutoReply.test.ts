import { AUTO_REPLY_JANELA_MS, AUTO_REPLY_MAX, AUTO_REPLY_PADRAO, autoReplyLimitesOf, autoReplyPadraoDo, autoReplyTextOf, maybeAutoReply, shouldAutoReply } from "./whatsappAutoReply";

// LGPD 06-01: o token do ambiente (WHATSAPP_ACCESS_TOKEN) só vale como reserva com liberação explícita.
process.env.ALLOW_GLOBAL_CHANNEL_CREDENTIALS = "true";

const conta = { id: "a1", phoneNumberId: "pn1", autoReplyEnabled: true, autoReplyText: null, credentials: null };
const ok = (wamid = "wamid.AUTO") => jest.fn(async () => ({ ok: true, json: async () => ({ messages: [{ id: wamid }] }) }));

function fakePrisma(opts: { jaEnviadas?: number; tenant?: Record<string, unknown> | null } = {}) {
  return {
    tenant: { findUnique: jest.fn(async () => (opts.tenant === undefined ? { name: "Tenant X" } : opts.tenant)) },
    conversation: {
      findFirst: jest.fn(async () => ({ id: "c1", waId: "5579999990000" })),
      update: jest.fn(async () => ({})),
    },
    waMessage: { create: jest.fn(async () => ({})), count: jest.fn(async () => opts.jaEnviadas ?? 0) },
  } as any;
}

describe("texto da resposta automática (LGPD 02-08)", () => {
  it("sem configuração: texto neutro, sem telefone fixo no código, ensinando a parar", () => {
    expect(autoReplyTextOf({ autoReplyText: null })).toBe(AUTO_REPLY_PADRAO);
    expect(autoReplyTextOf({ autoReplyText: "   " }, { name: "Tenant X" })).toBe(AUTO_REPLY_PADRAO);
    expect(AUTO_REPLY_PADRAO).not.toMatch(/\d{4}-?\d{4}/); // nenhum telefone
    expect(AUTO_REPLY_PADRAO).not.toContain("99837");
    expect(AUTO_REPLY_PADRAO).toContain("responda SAIR");
  });
  it("com o controlador configurado: identifica quem trata, dá o canal do titular e ensina a parar", () => {
    const t = autoReplyPadraoDo({ controladorNome: "Top Conta Ltda", encarregadoNome: "Encarregado de Dados", encarregadoContato: "privacidade@topconta.com.br" });
    expect(t).toContain("Top Conta Ltda");
    expect(t).toContain("Encarregado de Dados: privacidade@topconta.com.br");
    expect(t).toContain("seus dados pessoais");
    expect(t).toMatch(/responda SAIR\.$/);
    // só o contato, sem nome: ainda dá o canal
    expect(autoReplyPadraoDo({ encarregadoContato: "(11) 4000-0000" })).toContain("(11) 4000-0000");
  });
  it("usa o texto da conta quando existe; sem instrução de saída, ganha a instrução no fim", () => {
    expect(autoReplyTextOf({ autoReplyText: " Fale com o suporte. Para sair, responda SAIR " })).toBe("Fale com o suporte. Para sair, responda SAIR");
    expect(autoReplyTextOf({ autoReplyText: " Fale com o suporte " })).toBe("Fale com o suporte\n\nResponda SAIR para não receber mais mensagens.");
  });
});

describe("shouldAutoReply", () => {
  it("responde mensagem nova de quem não pediu descadastro", () => {
    expect(shouldAutoReply({ autoReplyEnabled: true }, { stored: true, optedOut: false })).toBe(true);
  });
  it("não responde se estiver desligada, duplicada (reenvio da Meta) ou descadastro", () => {
    expect(shouldAutoReply({ autoReplyEnabled: false }, { stored: true, optedOut: false })).toBe(false);
    expect(shouldAutoReply({ autoReplyEnabled: true }, { stored: false, optedOut: false })).toBe(false);
    expect(shouldAutoReply({ autoReplyEnabled: true }, { stored: true, optedOut: true })).toBe(false);
  });
});

describe("maybeAutoReply", () => {
  const inbound = { stored: true, optedOut: false, conversationId: "c1" };

  it("envia o texto padrão e grava a saída marcada como automática", async () => {
    const prisma = fakePrisma();
    const fetchImpl = ok();
    expect(await maybeAutoReply(prisma, "t1", { ...conta, credentials: null }, inbound, { fetchImpl })).toBe(false); // sem token: não envia
    expect(fetchImpl).not.toHaveBeenCalled();

    process.env.WHATSAPP_ACCESS_TOKEN = "tok";
    try {
      expect(await maybeAutoReply(fakePrisma(), "t1", conta, inbound, { fetchImpl })).toBe(true);
      const body = JSON.parse((fetchImpl.mock.calls[0] as any)[1].body);
      expect(body.to).toBe("5579999990000");
      expect(body.text.body).toBe(AUTO_REPLY_PADRAO);

      // LGPD 02-08: o padrão vem do controlador DESTE tenant
      const f2 = ok();
      const prisma = fakePrisma({ tenant: { name: "B", controladorNome: "Empresa B", encarregadoContato: "dpo@b.com" } });
      expect(await maybeAutoReply(prisma, "tB", conta, inbound, { fetchImpl: f2 })).toBe(true);
      expect(prisma.tenant.findUnique.mock.calls[0][0].where).toEqual({ id: "tB" });
      const texto = JSON.parse((f2.mock.calls[0] as any)[1].body).text.body;
      expect(texto).toContain("Empresa B");
      expect(texto).toContain("dpo@b.com");
    } finally {
      delete process.env.WHATSAPP_ACCESS_TOKEN;
    }
  });

  it("grava WaMessage SAIDA automática e não zera o não lido", async () => {
    process.env.WHATSAPP_ACCESS_TOKEN = "tok";
    try {
      const prisma = fakePrisma();
      await maybeAutoReply(prisma, "t1", conta, inbound, { fetchImpl: ok("wamid.X") });
      const data = prisma.waMessage.create.mock.calls[0][0].data;
      expect(data).toMatchObject({ direction: "SAIDA", wamid: "wamid.X", automatic: true, status: "sent", conversationId: "c1" });
      expect(data.sentByUserId).toBeUndefined();
      const upd = prisma.conversation.update.mock.calls[0][0].data;
      expect(upd.unreadCount).toBeUndefined();
    } finally {
      delete process.env.WHATSAPP_ACCESS_TOKEN;
    }
  });

  it("responde a toda mensagem, até o máximo de 3 nas últimas 24 h", async () => {
    process.env.WHATSAPP_ACCESS_TOKEN = "tok";
    try {
      expect(AUTO_REPLY_MAX).toBe(3);
      for (const [ja, esperado] of [[0, true], [2, true], [3, false], [5, false]] as const) {
        const fetchImpl = ok();
        expect(await maybeAutoReply(fakePrisma({ jaEnviadas: ja }), "t1", conta, inbound, { fetchImpl })).toBe(esperado);
        expect(fetchImpl).toHaveBeenCalledTimes(esperado ? 1 : 0);
      }
    } finally {
      delete process.env.WHATSAPP_ACCESS_TOKEN;
    }
  });

  it("usa o máximo e a janela configurados na conta", async () => {
    process.env.WHATSAPP_ACCESS_TOKEN = "tok";
    try {
      const cfg = { ...conta, autoReplyMax: 1, autoReplyJanelaHoras: 6 };
      for (const [ja, esperado] of [[0, true], [1, false]] as const) {
        expect(await maybeAutoReply(fakePrisma({ jaEnviadas: ja }), "t1", cfg, inbound, { fetchImpl: ok() })).toBe(esperado);
      }
      const prisma = fakePrisma();
      const now = new Date("2026-10-18T12:00:00Z");
      await maybeAutoReply(prisma, "t1", cfg, inbound, { fetchImpl: ok(), now });
      expect((prisma.waMessage.count as any).mock.calls[0][0].where.timestamp.gte).toEqual(new Date(now.getTime() - 6 * 3600_000));
    } finally {
      delete process.env.WHATSAPP_ACCESS_TOKEN;
    }
  });

  it("limite vazio ou fora da faixa volta ao padrão 3 por 24 h", () => {
    expect(autoReplyLimitesOf({})).toMatchObject({ max: 3, janelaHoras: 24 });
    expect(autoReplyLimitesOf({ autoReplyMax: 0, autoReplyJanelaHoras: 999 })).toMatchObject({ max: 3, janelaHoras: 24 });
    expect(autoReplyLimitesOf({ autoReplyMax: 10, autoReplyJanelaHoras: 72 })).toMatchObject({ max: 10, janelaHoras: 72 });
  });

  it("conta só respostas automáticas de saída da própria conversa na janela de 24 h", async () => {
    process.env.WHATSAPP_ACCESS_TOKEN = "tok";
    try {
      const prisma = fakePrisma();
      const now = new Date("2026-10-18T12:00:00Z");
      await maybeAutoReply(prisma, "t1", conta, inbound, { fetchImpl: ok(), now });
      expect(prisma.waMessage.count).toHaveBeenCalledWith({
        where: { tenantId: "t1", conversationId: "c1", direction: "SAIDA", automatic: true, timestamp: { gte: new Date(now.getTime() - AUTO_REPLY_JANELA_MS) } },
      });
    } finally {
      delete process.env.WHATSAPP_ACCESS_TOKEN;
    }
  });

  it("se a Meta recusar, não grava mensagem (então não conta no limite)", async () => {
    process.env.WHATSAPP_ACCESS_TOKEN = "tok";
    try {
      const prisma = fakePrisma();
      const fetchImpl = jest.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "boom", code: 100 } }) }));
      expect(await maybeAutoReply(prisma, "t1", conta, inbound, { fetchImpl: fetchImpl as any })).toBe(false);
      expect(prisma.waMessage.create).not.toHaveBeenCalled();
    } finally {
      delete process.env.WHATSAPP_ACCESS_TOKEN;
    }
  });
});

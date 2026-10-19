import { parseTemplateEvents } from "./whatsappPayload";
import { applyTemplateEvent, syncTemplatesFromMeta } from "./whatsappTemplateSync";
import { sendTemplateReply, isSendableTemplate } from "./whatsappReply";

function fakeTemplates(local: any[]) {
  const updates: any[] = [];
  const created: any[] = [];
  const media: any[] = [];
  const prisma: any = {
    messageTemplate: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.OR
          ? local.find((t) => where.OR.some((o: any) => (o.providerTemplateId && o.providerTemplateId === t.providerTemplateId) || (o.metaName && o.metaName === t.metaName))) ?? null
          : local.find((t) => t.name === where.name) ?? null
      ),
      update: jest.fn(async (a: any) => void updates.push(a)),
      create: jest.fn(async ({ data }: any) => {
        created.push(data);
        return { id: `novo${created.length}`, ...data };
      }),
    },
    templateMedia: { create: jest.fn(async ({ data }: any) => void media.push(data)) },
  };
  return { prisma, updates, created, media };
}
const tpl = { id: "t1", providerTemplateId: "555", metaName: "oferta_v1", language: "pt_BR", category: "MARKETING" };

describe("eventos de template do webhook", () => {
  it("lê status, qualidade e recategorização", () => {
    const body = {
      entry: [
        {
          id: "WABA1",
          changes: [
            { field: "message_template_status_update", value: { event: "REJECTED", message_template_id: 555, message_template_name: "oferta_v1", message_template_language: "pt_BR", reason: "INVALID_FORMAT" } },
            { field: "message_template_quality_update", value: { new_quality_score: "RED", message_template_id: 555 } },
            { field: "template_category_update", value: { new_category: "MARKETING", message_template_id: 555 } },
            { field: "messages", value: {} },
          ],
        },
      ],
    };
    const evs = parseTemplateEvents(body);
    expect(evs).toHaveLength(3);
    expect(evs[0]).toMatchObject({ wabaId: "WABA1", kind: "status", status: "REJECTED", metaTemplateId: "555", reason: "INVALID_FORMAT" });
    expect(evs[1]).toMatchObject({ kind: "quality", quality: "RED" });
    expect(evs[2]).toMatchObject({ kind: "category", category: "MARKETING" });
  });
});

describe("applyTemplateEvent / sync", () => {
  it("aprovação libera o template e limpa o motivo", async () => {
    const { prisma, updates } = fakeTemplates([tpl]);
    await applyTemplateEvent(prisma, "t1", { wabaId: "W", kind: "status", metaTemplateId: "555", name: "oferta_v1", language: "pt_BR", status: "APPROVED" });
    expect(updates[0].data).toMatchObject({ metaStatus: "APPROVED", status: "APROVADO", rejectionReason: null });
  });
  it("reprovação guarda o motivo explicado", async () => {
    const { prisma, updates } = fakeTemplates([tpl]);
    await applyTemplateEvent(prisma, "t1", { wabaId: "W", kind: "status", metaTemplateId: "555", name: null, language: null, status: "REJECTED", reason: "INVALID_FORMAT" });
    expect(updates[0].data).toMatchObject({ status: "REJEITADO" });
    expect(updates[0].data.rejectionReason).toContain("INVALID_FORMAT");
  });
  it("template desconhecido (criado direto na Meta) é ignorado", async () => {
    const { prisma, updates } = fakeTemplates([tpl]);
    expect(await applyTemplateEvent(prisma, "t1", { wabaId: "W", kind: "status", metaTemplateId: "999", name: "outro", language: "pt_BR", status: "APPROVED" })).toBe(false);
    expect(updates).toHaveLength(0);
  });
  it("recategorização para marketing atualiza a categoria local", async () => {
    const { prisma, updates } = fakeTemplates([{ ...tpl, category: "UTILITY" }]);
    await applyTemplateEvent(prisma, "t1", { wabaId: "W", kind: "category", metaTemplateId: "555", name: null, language: null, category: "MARKETING" });
    expect(updates[0].data.category).toBe("MARKETING");
  });
  it("sync atualiza os conhecidos e IMPORTA os que só existem na Meta", async () => {
    const { prisma, updates, created } = fakeTemplates([tpl]);
    const r = await syncTemplatesFromMeta(prisma, "t1", "W", "T", undefined, [
      { id: "555", name: "oferta_v1", status: "APPROVED", language: "pt_BR", category: "MARKETING", quality_score: { score: "GREEN" } },
      { id: "777", name: "so_na_meta", status: "APPROVED", category: "UTILITY", language: "pt_BR", components: [{ type: "BODY", text: "Olá {{1}}, tudo bem?", example: { body_text: [["Ana"]] } }] },
      { id: "888", name: "auth_code", status: "APPROVED", category: "AUTHENTICATION", language: "pt_BR" },
      { id: "999", name: "reprovado", status: "REJECTED", category: "MARKETING", language: "pt_BR" },
    ]);
    expect(r).toMatchObject({ atualizados: 1, importados: 1, total: 4 });
    expect(r.somenteNaMeta.map((x) => x.name)).toEqual(["auth_code", "reprovado"]);
    expect(updates[0].data).toMatchObject({ status: "APROVADO", qualityScore: "GREEN" });
    expect(created[0]).toMatchObject({
      name: "so_na_meta",
      origin: "META",
      metaName: "so_na_meta",
      metaStatus: "APPROVED",
      status: "APROVADO",
      category: "UTILITY",
      metaBody: "Olá {{1}}, tudo bem?",
      body: "Olá {{nome}}, tudo bem?",
      variableMap: ["nome"],
      providerTemplateId: "777",
    });
  });

  it("template importado com imagem de exemplo guarda a imagem; nome repetido ganha sufixo", async () => {
    const { prisma, created, media } = fakeTemplates([{ id: "x", name: "com_imagem", providerTemplateId: "1", metaName: "outro" }]);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const fetchImpl = jest.fn(async () => ({ ok: true, headers: { get: () => "image/png" }, arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.length) }));
    await syncTemplatesFromMeta(prisma, "t1", "W", "T", fetchImpl, [
      { id: "42", name: "com_imagem", status: "APPROVED", category: "MARKETING", language: "pt_BR", components: [{ type: "HEADER", format: "IMAGE", example: { header_handle: ["https://cdn.example/a.png"] } }, { type: "BODY", text: "Oi" }] },
    ]);
    expect(created[0]).toMatchObject({ name: "com_imagem (Meta)", headerFormat: "IMAGE" });
    expect(media[0]).toMatchObject({ mime: "image/png", size: 7 });
  });
});

describe("sendTemplateReply (fora da janela de 24h)", () => {
  const now = new Date("2026-10-11T12:00:00Z");
  const approved = { id: "tp1", channel: "WHATSAPP", status: "APROVADO", metaStatus: "APPROVED", metaName: "oferta_v1", language: "pt_BR", body: "Olá {{nome}}, seu limite é {{limite}}. Responda se quiser." };
  function fake(client: any, template: any) {
    const created: any[] = [];
    const prisma: any = {
      conversation: { findFirst: jest.fn(async () => ({ id: "c1", waId: "5584999998888", contactName: "Maria", client, account: { phoneNumberId: "1055", active: true } })), update: jest.fn() },
      messageTemplate: { findFirst: jest.fn(async () => template) },
      waMessage: { create: jest.fn(async ({ data }: any) => { created.push(data); return { id: "m1", ...data }; }) },
      // supressão por telefone (LGPD 02-03): nada suprimido
      tenant: { findUnique: jest.fn(async () => ({ cpfSalt: "salt", baseLegalMarketing: "LEGITIMO_INTERESSE" })) },
      supressaoTitular: { findMany: jest.fn(async () => []) },
      client: { findMany: jest.fn(async () => []) },
      campaignRecipient: { findMany: jest.fn(async () => []) },
    };
    return { prisma, created };
  }
  const client = { nome: "Maria Silva", cidade: "Natal", percentualUtilizado: 40, saldoDisponivel: 500, limiteTotal: 1500, autorizacaoComunicacao: true, optOutAt: null };
  const okFetch = jest.fn(async (_u: string, _i?: any) => ({ ok: true, status: 200, json: async () => ({ messages: [{ id: "wamid.TPL" }] }) }));

  it("envia o template com os dados do cliente e grava o texto final", async () => {
    const { prisma, created } = fake(client, approved);
    await sendTemplateReply(prisma, "t1", "u1", "c1", "tp1", { token: "T", fetchImpl: okFetch, now });
    const body = JSON.parse((okFetch.mock.calls[0] as any)[1].body);
    expect(body.template.components[0].parameters.map((p: any) => p.text)).toEqual(["Maria Silva", expect.stringContaining("1.500")]);
    expect(created[0]).toMatchObject({ type: "template", direction: "SAIDA", wamid: "wamid.TPL", status: "sent" });
    expect(created[0].body).toContain("Maria Silva");
  });
  it("cliente que pediu para parar não recebe, mesmo com template", async () => {
    const { prisma, created } = fake({ ...client, optOutAt: new Date() }, approved);
    await expect(sendTemplateReply(prisma, "t1", "u1", "c1", "tp1", { token: "T", fetchImpl: okFetch, now })).rejects.toMatchObject({ code: "OPT_OUT" });
    expect(created).toHaveLength(0);
  });
  it("template que a Meta ainda não aprovou não sai, mesmo marcado como aprovado", async () => {
    const { prisma } = fake(client, { ...approved, metaStatus: "PENDING" });
    await expect(sendTemplateReply(prisma, "t1", "u1", "c1", "tp1", { token: "T", now })).rejects.toMatchObject({ code: "TEMPLATE_INDISPONIVEL" });
    expect(isSendableTemplate({ ...approved, metaName: null })).toBe(false);
    expect(isSendableTemplate(approved)).toBe(true);
  });
  it("sem cliente na base usa só o nome do perfil", async () => {
    const { prisma } = fake(null, { ...approved, body: "Olá {{nome}}, tudo bem? Temos uma novidade." });
    const f = jest.fn(async (_u: string, _i?: any) => ({ ok: true, status: 200, json: async () => ({ messages: [{ id: "w" }] }) }));
    await sendTemplateReply(prisma, "t1", "u1", "c1", "tp1", { token: "T", fetchImpl: f, now });
    expect(JSON.parse((f.mock.calls[0] as any)[1].body).template.components[0].parameters[0].text).toBe("Maria");
  });
});

import {
  buildBodyParams,
  buildCreatePayload,
  createMetaTemplate,
  explainTemplateIssue,
  listMetaTemplates,
  mapMetaStatus,
  metaTemplateName,
  normalizeButtonPhone,
  renderMetaPreview,
  sendTemplateMessage,
  toMetaBody,
  validateTemplate,
  variableOrder,
  templateTemOptOut,
} from "./whatsappTemplates";

const ok = (body: any) => ({ ok: true, status: 200, json: async () => body });
const fail = (status: number, body: any) => ({ ok: false, status, json: async () => body });
const base = { body: "Olá {{nome}}, seu limite é {{limite}}. Responda se quiser usar.", category: "MARKETING", footer: "Responda SAIR para não receber mais mensagens" };

describe("variáveis e conversão para o formato da Meta", () => {
  it("numera na ordem em que aparecem, sem repetir", () => {
    expect(variableOrder("Oi {{nome}}, {{saldo}} e de novo {{nome}}!")).toEqual(["nome", "saldo"]);
    expect(toMetaBody("Oi {{nome}}, {{saldo}} e de novo {{ nome }}!")).toBe("Oi {{1}}, {{2}} e de novo {{1}}!");
  });
  it("parâmetros seguem a ordem e são higienizados (a Meta recusa vazio e quebra de linha)", () => {
    expect(buildBodyParams("Oi {{nome}}, limite {{limite}}!", { nome: "Maria\nSilva", limite: "" })).toEqual(["Maria Silva", "-"]);
    expect(buildBodyParams("Oi {{nome}}!", { nome: null })).toEqual(["-"]);
    expect(buildBodyParams("Oi {{nome}}!", { nome: "A     B" })).toEqual(["A   B"]);
  });
  it("monta o texto final que o cliente vê", () => {
    expect(renderMetaPreview("Oi {{nome}}, limite {{limite}}!", ["Maria", "R$ 1.000"])).toBe("Oi Maria, limite R$ 1.000!");
  });
});

describe("validateTemplate", () => {
  it("aceita um template correto", () => {
    expect(validateTemplate(base)).toEqual([]);
  });
  it("recusa variável no começo, no fim ou duas coladas", () => {
    expect(validateTemplate({ ...base, body: "{{nome}}, olá! Tudo bem?" }).join(" ")).toContain("começar com uma variável");
    expect(validateTemplate({ ...base, body: "Seu limite é {{limite}}" }).join(" ")).toContain("terminar com uma variável");
    expect(validateTemplate({ ...base, body: "Olá {{nome}}{{cidade}} tudo bem?" }).join(" ")).toContain("coladas");
  });
  it("recusa variável desconhecida", () => {
    expect(validateTemplate({ ...base, body: "Olá {{apelido}}, tudo bem?" }).join(" ")).toContain("{{apelido}}");
  });
  it("limites de texto, rodapé e botões", () => {
    expect(validateTemplate({ ...base, body: "a".repeat(1025) }).join(" ")).toContain("1024");
    expect(validateTemplate({ ...base, footer: "x".repeat(61) }).join(" ")).toContain("rodapé");
    expect(validateTemplate({ ...base, footer: "Oi {{nome}}" }).join(" ")).toContain("variáveis");
    expect(validateTemplate({ ...base, quickReplies: ["a", "b", "c", "d"] })).toEqual([]);
    expect(validateTemplate({ ...base, quickReplies: Array.from({ length: 11 }, (_, i) => `b${i}`) }).join(" ")).toContain("No máximo 10");
    expect(validateTemplate({ ...base, quickReplies: ["x".repeat(26)] }).join(" ")).toContain("25");
    expect(validateTemplate({ ...base, quickReplies: ["Sim", "sim"] }).join(" ")).toContain("mesmo texto");
  });
  it("botões de link e de ligar", () => {
    const ok = validateTemplate({ ...base, buttons: [{ type: "URL", text: "Abrir o app", url: "https://topconta.com.br/app" }, { type: "PHONE_NUMBER", text: "Ligar", phone: "(84) 99999-8888" }] });
    expect(ok).toEqual([]);
    const v = (buttons: any[], quickReplies: string[] = []) => validateTemplate({ ...base, buttons, quickReplies }).join(" ");
    expect(v([{ type: "URL", text: "Site", url: "http://x.com" }])).toContain("https://");
    expect(v([{ type: "URL", text: "Site", url: "https://x.com/{{1}}" }])).toContain("variável");
    expect(v([{ type: "URL", text: "Site", url: "" }])).toContain("Informe o link");
    expect(v([{ type: "URL", text: "", url: "https://x.com" }])).toContain("texto do botão");
    expect(v([{ type: "URL", text: "x".repeat(26), url: "https://x.com" }])).toContain("25");
    expect(v([{ type: "PHONE_NUMBER", text: "Ligar", phone: "123" }])).toContain("telefone válido");
    const tres = [1, 2, 3].map((i) => ({ type: "URL", text: `L${i}`, url: `https://x.com/${i}` }));
    expect(v(tres)).toContain("No máximo 2 botões de link");
    const doisFones = [1, 2].map((i) => ({ type: "PHONE_NUMBER", text: `T${i}`, phone: "84999998888" }));
    expect(v(doisFones)).toContain("No máximo 1 botão de ligar");
    expect(v([{ type: "URL", text: "Sim", url: "https://x.com" }], ["sim"])).toContain("mesmo texto");
    expect(v([{ type: "URL", text: "Site", url: "https://x.com" }], Array.from({ length: 10 }, (_, i) => `q${i}`))).toContain("No máximo 10 botões no total");
  });
  it("telefone do botão vira +DDI", () => {
    expect(normalizeButtonPhone("(84) 99999-8888")).toBe("+5584999998888");
    expect(normalizeButtonPhone("+55 84 99999-8888")).toBe("+5584999998888");
    expect(normalizeButtonPhone("0800")).toBeNull();
  });
  it("marketing sem rodapé de saída nem botão SAIR é aceito (só o assistente de campanha avisa)", () => {
    const semSaida = { body: base.body, category: "MARKETING" };
    expect(validateTemplate(semSaida)).toEqual([]);
    expect(validateTemplate({ ...semSaida, footer: "TopConta, cartão de benefícios" })).toEqual([]);
    expect(templateTemOptOut({ footer: null, quickReplies: ["Sim", "Não quero"] })).toBe(false);
    expect(templateTemOptOut({ footer: null, quickReplies: ["Sair da lista"] })).toBe(true);
  });
  it("exige a categoria", () => {
    expect(validateTemplate({ ...base, category: null }).join(" ")).toContain("categoria");
    expect(validateTemplate({ ...base, category: "AUTHENTICATION" }).join(" ")).toContain("categoria");
  });
});

describe("nome e payload de criação", () => {
  it("nome na Meta: sem acento, minúsculo, com versão", () => {
    expect(metaTemplateName("Oferta de Antecipação — Outubro!", 1)).toBe("oferta_de_antecipacao_outubro_v1");
    expect(metaTemplateName("???", 2)).toBe("template_v2");
  });
  it("corpo com exemplos na ordem das variáveis, rodapé e botões", () => {
    const p: any = buildCreatePayload({ name: "Oferta", language: "pt_BR", version: 1, ...base, footer: "Responda SAIR para parar", quickReplies: ["Quero saber mais", "SAIR"] });
    expect(p).toMatchObject({ name: "oferta_v1", language: "pt_BR", category: "MARKETING" });
    expect(p.components[0]).toMatchObject({ type: "BODY", text: "Olá {{1}}, seu limite é {{2}}. Responda se quiser usar.", example: { body_text: [["Maria", "R$ 1.500,00"]] } });
    expect(p.components[1]).toEqual({ type: "FOOTER", text: "Responda SAIR para parar" });
    expect(p.components[2].buttons).toEqual([{ type: "QUICK_REPLY", text: "Quero saber mais" }, { type: "QUICK_REPLY", text: "SAIR" }]);
  });
  it("botões: respostas rápidas primeiro, depois link e telefone", () => {
    const p: any = buildCreatePayload({
      name: "Oferta",
      language: "pt_BR",
      version: 1,
      ...base,
      quickReplies: ["SAIR"],
      buttons: [
        { type: "URL", text: "Abrir o app", url: "https://topconta.com.br/app" },
        { type: "PHONE_NUMBER", text: "Ligar", phone: "(84) 99999-8888" },
      ],
    });
    expect(p.components[p.components.length - 1].buttons).toEqual([
      { type: "QUICK_REPLY", text: "SAIR" },
      { type: "URL", text: "Abrir o app", url: "https://topconta.com.br/app" },
      { type: "PHONE_NUMBER", text: "Ligar", phone_number: "+5584999998888" },
    ]);
  });
  it("sem variáveis não manda exemplo", () => {
    const p: any = buildCreatePayload({ name: "Aviso", language: "pt_BR", version: 1, body: "Olá, temos novidades para você.", category: "UTILITY" });
    expect(p.components[0].example).toBeUndefined();
  });
});

describe("status da Meta", () => {
  it("mapeia para o status local", () => {
    expect(mapMetaStatus("APPROVED")).toBe("APROVADO");
    expect(mapMetaStatus("PENDING")).toBe("PENDENTE_APROVACAO");
    expect(mapMetaStatus("REJECTED")).toBe("REJEITADO");
    expect(mapMetaStatus("PAUSED")).toBe("REJEITADO"); // pausado não pode ser usado
    expect(mapMetaStatus("DISABLED")).toBe("REJEITADO");
    expect(mapMetaStatus("algo-novo")).toBeNull();
  });
  it("explica reprovação, pausa e desativação", () => {
    expect(explainTemplateIssue("REJECTED", "INVALID_FORMAT")).toContain("INVALID_FORMAT");
    expect(explainTemplateIssue("PAUSED")).toContain("qualidade");
    expect(explainTemplateIssue("APPROVED")).toBeNull();
  });
});

describe("Graph API de templates", () => {
  it("cria o template e devolve id e status", async () => {
    const f = jest.fn(async (_u: string, _i?: any) => ok({ id: "555", status: "PENDING", category: "MARKETING" }));
    const r = await createMetaTemplate("WABA1", "TOKEN", { name: "x" }, f as any);
    expect(r).toEqual({ id: "555", status: "PENDING", category: "MARKETING" });
    const [url, init] = f.mock.calls[0] as [string, any];
    expect(url).toContain("/WABA1/message_templates");
    expect(init.headers.Authorization).toBe("Bearer TOKEN");
  });
  it("traduz erro de nome repetido", async () => {
    const f = jest.fn(async () => fail(400, { error: { code: 100, error_subcode: 2388024, message: "x" } }));
    await expect(createMetaTemplate("W", "T", {}, f as any)).rejects.toMatchObject({ message: expect.stringContaining("Já existe") });
  });
  it("sem token não chama a Meta", async () => {
    const f = jest.fn();
    await expect(createMetaTemplate("W", undefined, {}, f as any)).rejects.toMatchObject({ code: "SEM_TOKEN" });
    expect(f).not.toHaveBeenCalled();
  });
  it("lista seguindo a paginação", async () => {
    const f = jest
      .fn()
      .mockResolvedValueOnce(ok({ data: [{ id: "1", name: "a", status: "APPROVED" }], paging: { next: "https://graph.facebook.com/next" } }))
      .mockResolvedValueOnce(ok({ data: [{ id: "2", name: "b", status: "PENDING" }] }));
    const r = await listMetaTemplates("W", "T", f as any);
    expect(r.map((t) => t.id)).toEqual(["1", "2"]);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("envia template com idioma e parâmetros do corpo", async () => {
    const f = jest.fn(async (_u: string, _i?: any) => ok({ messages: [{ id: "wamid.T" }] }));
    const id = await sendTemplateMessage("1055", "T", "5584999998888", "oferta_v1", "pt_BR", ["Maria", "R$ 1.000"], f as any);
    expect(id).toBe("wamid.T");
    const body = JSON.parse((f.mock.calls[0] as any)[1].body);
    expect(body).toMatchObject({ type: "template", to: "5584999998888", template: { name: "oferta_v1", language: { code: "pt_BR" }, components: [{ type: "body", parameters: [{ type: "text", text: "Maria" }, { type: "text", text: "R$ 1.000" }] }] } });
  });
  it("template sem variáveis não manda components", async () => {
    const f = jest.fn(async (_u: string, _i?: any) => ok({ messages: [{ id: "w" }] }));
    await sendTemplateMessage("1055", "T", "55", "aviso_v1", "pt_BR", [], f as any);
    expect(JSON.parse((f.mock.calls[0] as any)[1].body).template.components).toBeUndefined();
  });
});

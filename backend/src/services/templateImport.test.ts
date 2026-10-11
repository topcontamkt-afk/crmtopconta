import { applyVariableMap, guessVariable, importMetaTemplate, positionsIn, unmappedPositions, validateVariableMap } from "./templateImport";
import { templateParams, templatePreview, buildCreatePayload } from "./whatsappTemplates";
import { costConfigFrom, DEFAULT_COSTS, estimateCost } from "./messageCost";

const meta = (over: any = {}) => ({
  id: "1",
  name: "dia_das_criancas",
  status: "APPROVED",
  category: "MARKETING",
  language: "pt_BR",
  components: [
    { type: "HEADER", format: "IMAGE", example: { header_handle: ["https://scontent.example/img.jpg"] } },
    { type: "BODY", text: "Olá {{1}}, você tem {{2}} de limite disponível.", example: { body_text: [["Maria", "R$ 850,00"]] } },
    { type: "FOOTER", text: "TopConta" },
    { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "SAIR" }, { type: "URL", text: "Abrir", url: "https://topconta.com.br" }] },
  ],
  ...over,
});

describe("importMetaTemplate", () => {
  it("converte texto, cabeçalho de imagem, rodapé e botões", () => {
    const t = importMetaTemplate(meta());
    expect(t.metaBody).toBe("Olá {{1}}, você tem {{2}} de limite disponível.");
    expect(t.variableMap).toEqual(["nome", "limite_disponivel"]);
    expect(t.body).toBe("Olá {{nome}}, você tem {{limite_disponivel}} de limite disponível.");
    expect(t.headerFormat).toBe("IMAGE");
    expect(t.headerExampleUrl).toBe("https://scontent.example/img.jpg");
    expect(t.footer).toBe("TopConta");
    expect(t.quickReplies).toEqual(["SAIR"]);
    expect(t.buttons).toEqual([{ type: "URL", text: "Abrir", url: "https://topconta.com.br" }]);
    expect(t.category).toBe("MARKETING");
    expect(t.sendIssue).toBeNull();
  });

  it("deixa sem mapa a variável que não dá para adivinhar e avisa", () => {
    const t = importMetaTemplate(meta({ components: [{ type: "BODY", text: "Oi {{1}}, código {{2}}.", example: { body_text: [["Ana", "XK-9"]] } }] }));
    expect(t.variableMap).toEqual(["nome", null]);
    expect(unmappedPositions(t.variableMap)).toEqual([2]);
    expect(t.body).toBe("Oi {{nome}}, código {{2}}.");
  });

  it("marca o que ainda não sabemos enviar", () => {
    expect(importMetaTemplate(meta({ components: [{ type: "HEADER", format: "VIDEO" }, { type: "BODY", text: "Oi" }] })).sendIssue).toMatch(/vídeo/);
    expect(importMetaTemplate(meta({ components: [{ type: "BODY", text: "Oi" }, { type: "BUTTONS", buttons: [{ type: "URL", text: "Ver", url: "https://x.com/{{1}}" }] }] })).sendIssue).toMatch(/link com variável/);
    expect(importMetaTemplate(meta({ components: [{ type: "BODY", text: "Oi {{nome}}" }], parameter_format: "NAMED" })).sendIssue).toMatch(/nomeadas/);
    expect(importMetaTemplate(meta({ category: "AUTHENTICATION" })).sendIssue).toMatch(/autenticação/);
  });
});

describe("variáveis posicionais", () => {
  it("lista posições, aplica o mapa e valida", () => {
    expect(positionsIn("{{2}} e {{1}} e {{2}}")).toEqual([1, 2]);
    expect(applyVariableMap("Oi {{1}} {{2}}", ["nome", null])).toBe("Oi {{nome}} {{2}}");
    expect(validateVariableMap(["nome", "saldo"], 2)).toBeNull();
    expect(validateVariableMap(["nome"], 2)).toMatch(/2 posição/);
    expect(validateVariableMap(["nome", "cpf"], 2)).toMatch(/desconhecida/);
  });

  it("palpite pelo exemplo", () => {
    expect(guessVariable("Maria", 0)).toBe("nome");
    expect(guessVariable("R$ 850,00", 1)).toBe("limite_disponivel");
    expect(guessVariable("45", 1)).toBe("percentual");
    expect(guessVariable("XK-9", 1)).toBeNull();
  });

  it("parâmetros e texto do template importado seguem o mapa; o local segue o texto", () => {
    const imp = { body: "Olá {{nome}}, tem {{limite_disponivel}}", metaBody: "Olá {{1}}, tem {{2}}", variableMap: ["nome", "limite_disponivel"] };
    const ctx = { nome: "Ana", limite_disponivel: "R$ 300,00", saldo: "R$ 300,00" };
    const params = templateParams(imp, ctx);
    expect(params).toEqual(["Ana", "R$ 300,00"]);
    expect(templatePreview(imp, params)).toBe("Olá Ana, tem R$ 300,00");
    // posição repetida/fora de ordem no original continua certa
    const odd = { body: "", metaBody: "{{2}} / {{1}}", variableMap: ["nome", "saldo"] };
    expect(templatePreview(odd, templateParams(odd, ctx))).toBe("R$ 300,00 / Ana");
    // template nosso: ordem das variáveis do texto
    expect(templateParams({ body: "Oi {{nome}}, {{saldo}}" }, ctx)).toEqual(["Ana", "R$ 300,00"]);
  });
});

describe("cabeçalho de imagem na criação", () => {
  it("inclui o HEADER com o handle de exemplo antes do corpo", () => {
    const p = buildCreatePayload({ name: "x", language: "pt_BR", version: 1, body: "Olá {{nome}}, tudo bem?", category: "MARKETING", headerHandle: "4::abc" });
    expect(p.components[0]).toEqual({ type: "HEADER", format: "IMAGE", example: { header_handle: ["4::abc"] } });
    expect(p.components[1].type).toBe("BODY");
    const sem = buildCreatePayload({ name: "x", language: "pt_BR", version: 1, body: "Olá {{nome}}, tudo bem?", category: "MARKETING" });
    expect(sem.components[0].type).toBe("BODY");
  });
});

describe("custo estimado", () => {
  it("o padrão reproduz R$ 0,41 por mensagem de marketing", () => {
    const cfg = costConfigFrom(null);
    const c = estimateCost("MARKETING", cfg, 4272);
    expect(c.brl).toBeCloseTo(0.41, 2);
    expect(c.total).toBeCloseTo(0.4102 * 4272, 0);
  });

  it("categoria sem preço informado não inventa valor", () => {
    expect(DEFAULT_COSTS.utilidadeUsd).toBeNull();
    expect(estimateCost("UTILITY", costConfigFrom(null), 10).brl).toBeNull();
    expect(estimateCost("UTILITY", costConfigFrom({ custoUtilidadeUsd: 0.01 }), 100)).toMatchObject({ brl: 0.0499, total: 4.99 });
    expect(estimateCost(null, costConfigFrom(null), 10).brl).toBeNull();
  });

  it("usa o que foi configurado", () => {
    const cfg = costConfigFrom({ custoMarketingUsd: 0.05, cambioUsdBrl: 5 });
    expect(estimateCost("MARKETING", cfg, 2).brl).toBe(0.25);
  });
});

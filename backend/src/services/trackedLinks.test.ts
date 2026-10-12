import { isBotUserAgent, makeToken, parseToken, TOKEN_LENGTH, trackedButtons, trackedUrlExample, trackedUrlPattern } from "./trackedLinks";
import { buildCreatePayload, sendTemplateMessage } from "./whatsappTemplates";

const SECRET = "segredo-de-teste";
const EVENT = "7f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

describe("código do link rastreado", () => {
  it("vai e volta com o id da mensagem e o botão", () => {
    const token = makeToken("e", EVENT, 2, SECRET);
    expect(token).toHaveLength(TOKEN_LENGTH);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/); // seguro para entrar na URL
    expect(parseToken(token, SECRET)).toEqual({ kind: "e", id: EVENT, buttonIndex: 2 });
    expect(parseToken(makeToken("n", EVENT, 0, SECRET), SECRET)).toMatchObject({ kind: "n", buttonIndex: 0 });
  });

  it("recusa código adulterado, de outro segredo ou malformado", () => {
    const token = makeToken("e", EVENT, 1, SECRET);
    const outroId = token.slice(0, 5) + (token[5] === "a" ? "b" : "a") + token.slice(6);
    expect(parseToken(outroId, SECRET)).toBeNull();
    expect(parseToken(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"), SECRET)).toBeNull();
    expect(parseToken(token, "outro-segredo")).toBeNull();
    expect(parseToken("curto", SECRET)).toBeNull();
    expect(parseToken(token + "x", SECRET)).toBeNull();
    expect(parseToken("x" + token.slice(1), SECRET)).toBeNull(); // tipo desconhecido
    expect(() => makeToken("e", "nao-e-uuid", 0, SECRET)).toThrow();
    expect(() => makeToken("e", EVENT, 16, SECRET)).toThrow();
  });

  it("códigos de mensagens diferentes são diferentes", () => {
    expect(makeToken("e", EVENT, 0, SECRET)).not.toBe(makeToken("e", "7f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e50", 0, SECRET));
  });
});

describe("botões rastreados do template", () => {
  const link = "https://topconta.onelink.me/tLP0/uwl4jeer";
  it("o índice conta as respostas rápidas primeiro (mesma ordem enviada à Meta)", () => {
    const t = {
      quickReplies: ["Quero", "SAIR"],
      buttons: [
        { type: "PHONE_NUMBER", text: "Ligar", phone: "+5584999998888" },
        { type: "URL", text: "Abrir o app", url: link, tracked: true },
        { type: "URL", text: "Site", url: "https://topconta.com.br" },
      ],
    };
    expect(trackedButtons(t)).toEqual([{ index: 3, text: "Abrir o app", url: link }]);
    expect(trackedButtons({ quickReplies: [], buttons: null })).toEqual([]);
  });

  it("a Meta recebe só o nosso endereço; o destino real não vai", () => {
    const p: any = buildCreatePayload({
      name: "Uso",
      language: "pt_BR",
      version: 1,
      body: "Olá {{nome}}, você tem limite disponível. Quer usar?",
      category: "MARKETING",
      buttons: [{ type: "URL", text: "Usar o limite", url: link, tracked: true }],
      linkBase: "https://links.exemplo.com.br/",
    });
    const botoes = p.components[p.components.length - 1].buttons;
    expect(botoes).toEqual([{ type: "URL", text: "Usar o limite", url: "https://links.exemplo.com.br/r/{{1}}", example: [trackedUrlExample("https://links.exemplo.com.br")] }]);
    expect(JSON.stringify(p)).not.toContain("onelink");
    expect(trackedUrlPattern("https://x.com/")).toBe("https://x.com/r/{{1}}");
    expect(() => buildCreatePayload({ name: "x", language: "pt_BR", version: 1, body: "Olá, tudo bem com você?", category: "MARKETING", buttons: [{ type: "URL", text: "A", url: link, tracked: true }] })).toThrow(/LINK_BASE_URL/);
  });

  it("no envio o código completa o botão certo", async () => {
    const fetchImpl = jest.fn(async (_u: string, _i?: any) => ({ ok: true, status: 200, json: async () => ({ messages: [{ id: "wamid.X" }] }) }));
    await sendTemplateMessage("1055", "T", "5584999998888", "uso_v1", "pt_BR", ["Ana"], fetchImpl, undefined, [{ index: 1, token: "TOKEN123" }]);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.template.components).toEqual([
      { type: "body", parameters: [{ type: "text", text: "Ana" }] },
      { type: "button", sub_type: "url", index: "1", parameters: [{ type: "text", text: "TOKEN123" }] },
    ]);
  });
});

describe("quem conta como clique", () => {
  it("prévia de link e robôs não contam", () => {
    expect(isBotUserAgent("WhatsApp/2.23.20.0 A")).toBe(true);
    expect(isBotUserAgent("facebookexternalhit/1.1")).toBe(true);
    expect(isBotUserAgent("curl/8.0")).toBe(true);
    expect(isBotUserAgent(undefined)).toBe(true);
    expect(isBotUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36")).toBe(false);
    expect(isBotUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1")).toBe(false);
  });
});

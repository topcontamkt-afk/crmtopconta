import { chaveDoProvedor, filtrarModelosOpenAI, listarModelos, MODELO_VALIDO, MODELOS_SUGERIDOS } from "./modelos";

const resp = (status: number, corpo: unknown) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => corpo });

describe("filtrarModelosOpenAI", () => {
  it("fica só com modelos de conversa, sem duplicados", () => {
    const r = filtrarModelosOpenAI(["gpt-4.1", "gpt-4o", "gpt-4o", "text-embedding-3-large", "whisper-1", "tts-1", "dall-e-3", "gpt-4o-realtime-preview", "gpt-4o-audio-preview", "omni-moderation-latest", "o3-mini", "gpt-image-1", "davinci-002", "babbage-002", "gpt-4o-mini-transcribe", "chatgpt-4o-latest"]);
    expect(r.sort()).toEqual(["chatgpt-4o-latest", "gpt-4.1", "gpt-4o", "o3-mini"]);
  });
});

describe("MODELO_VALIDO", () => {
  it.each(["claude-opus-5-5", "gpt-4.1", "ft:gpt-4o:org:nome:abc", "o3-mini"])("aceita %s", (id) => expect(MODELO_VALIDO.test(id)).toBe(true));
  it.each(["", " gpt", "gpt 4", "../x", "a".repeat(101), "gpt;drop", "-gpt"])("recusa %j", (id) => expect(MODELO_VALIDO.test(id)).toBe(false));
});

describe("chaveDoProvedor", () => {
  it("lê a chave certa de cada provedor e ignora vazio", () => {
    expect(chaveDoProvedor("anthropic", { ANTHROPIC_API_KEY: " sk-a ", OPENAI_API_KEY: "sk-o" } as any)).toBe("sk-a");
    expect(chaveDoProvedor("openai", { ANTHROPIC_API_KEY: "sk-a", OPENAI_API_KEY: "sk-o" } as any)).toBe("sk-o");
    expect(chaveDoProvedor("openai", { OPENAI_API_KEY: "  " } as any)).toBeUndefined();
  });
});

describe("listarModelos", () => {
  it("sem chave: devolve as sugestões e explica", async () => {
    const r = await listarModelos("openai", { apiKey: "" });
    expect(r).toMatchObject({ fonte: "sugeridos", modelos: MODELOS_SUGERIDOS.openai });
    expect(r.erro).toMatch(/chave/i);
  });

  it("OpenAI: lista ao vivo e filtra", async () => {
    const r = await listarModelos("openai", { apiKey: "k", fetchImpl: resp(200, { data: [{ id: "gpt-4.1" }, { id: "text-embedding-3-small" }, { id: "o3-mini" }] }) as any });
    expect(r).toEqual({ modelos: ["o3-mini", "gpt-4.1"], fonte: "api" });
  });

  it("OpenAI: chave recusada, erro de servidor e lista vazia caem nas sugestões com o motivo", async () => {
    expect((await listarModelos("openai", { apiKey: "k", fetchImpl: resp(401, {}) as any })).erro).toMatch(/recusada/);
    expect((await listarModelos("openai", { apiKey: "k", fetchImpl: resp(500, {}) as any })).erro).toMatch(/500/);
    const vazio = await listarModelos("openai", { apiKey: "k", fetchImpl: resp(200, { data: [{ id: "whisper-1" }] }) as any });
    expect(vazio.fonte).toBe("sugeridos");
  });

  it("OpenAI: falha de rede cai nas sugestões", async () => {
    const r = await listarModelos("openai", { apiKey: "k", fetchImpl: (async () => { throw new Error("rede"); }) as any });
    expect(r).toMatchObject({ fonte: "sugeridos", modelos: MODELOS_SUGERIDOS.openai });
  });

  it("Claude: lista ao vivo, só IDs claude-*", async () => {
    const r = await listarModelos("anthropic", { apiKey: "k", listarAnthropic: async () => ["claude-opus-5-5", "claude-sonnet-5-5", "outro"] });
    expect(r).toEqual({ modelos: ["claude-opus-5-5", "claude-sonnet-5-5"], fonte: "api" });
  });

  it("Claude: chave recusada cai nas sugestões", async () => {
    const r = await listarModelos("anthropic", { apiKey: "k", listarAnthropic: async () => { throw Object.assign(new Error("x"), { status: 401 }); } });
    expect(r).toMatchObject({ fonte: "sugeridos", erro: expect.stringMatching(/recusada/) });
  });
});

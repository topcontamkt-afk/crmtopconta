import { buildInstructions, buildSessionUpdate, buildTwiml, bridgeUrl, signVoiceToken, verifyVoiceToken } from "./voice";

beforeAll(() => {
  process.env.JWT_SECRET = "segredo-de-teste";
});

describe("token da ligação", () => {
  const ctx = { nome: "Maria", saldo: 250.5, ref: "abc" };
  it("assina e valida", () => {
    const t = signVoiceToken(ctx, 1_000_000);
    expect(verifyVoiceToken(t, 1_000_500)).toMatchObject({ nome: "Maria", saldo: 250.5, ref: "abc" });
  });
  it("expira", () => {
    const t = signVoiceToken(ctx, 1_000_000, 60);
    expect(verifyVoiceToken(t, 1_000_000 + 61_000)).toBeNull();
  });
  it("rejeita adulterado e lixo", () => {
    const t = signVoiceToken(ctx, 1_000_000);
    const [body, sig] = t.split(".");
    const outro = Buffer.from(JSON.stringify({ nome: "Outro", ref: "x", exp: 9e9 })).toString("base64url");
    expect(verifyVoiceToken(`${outro}.${sig}`, 1_000_500)).toBeNull();
    expect(verifyVoiceToken(`${body}.AAAA`, 1_000_500)).toBeNull();
    expect(verifyVoiceToken("lixo", 1_000_500)).toBeNull();
    expect(verifyVoiceToken(undefined)).toBeNull();
  });
  it("não vale com outro segredo", () => {
    const t = signVoiceToken(ctx, 1_000_000);
    process.env.JWT_SECRET = "outro";
    expect(verifyVoiceToken(t, 1_000_500)).toBeNull();
    process.env.JWT_SECRET = "segredo-de-teste";
  });
});

describe("TwiML e URL", () => {
  it("escapa o token e conecta ao stream", () => {
    const x = buildTwiml("wss://a.b/api/voice-bridge", 'x"<y>&');
    expect(x).toContain('<Stream url="wss://a.b/api/voice-bridge">');
    expect(x).toContain('value="x&quot;&lt;y&gt;&amp;"');
  });
  it("troca http por ws", () => {
    expect(bridgeUrl("https://crmtopconta-backend.vercel.app/")).toBe("wss://crmtopconta-backend.vercel.app/api/voice-bridge");
    expect(bridgeUrl("http://localhost:4000")).toBe("ws://localhost:4000/api/voice-bridge");
  });
});

describe("instruções e sessão", () => {
  it("menciona o saldo e manda confirmar a pessoa antes", () => {
    const i = buildInstructions({ nome: "Maria", saldo: 250.5, ref: "a" }, 90);
    expect(i).toContain("Maria");
    expect(i).toMatch(/R\$\s?250,50/);
    expect(i).toContain("Só depois de a pessoa confirmar");
    expect(i).toContain("90 segundos");
  });
  it("sem saldo não cita valor", () => {
    const i = buildInstructions({ nome: "João", ref: "a" }, 60);
    expect(i).not.toMatch(/R\$/);
  });
  it("usa áudio G.711 μ-law e as duas funções", () => {
    const s: any = buildSessionUpdate({ voice: "eve", instructions: "x" });
    expect(s.type).toBe("session.update");
    expect(s.session.audio.input.format.type).toBe("audio/pcmu");
    expect(s.session.audio.output.format.type).toBe("audio/pcmu");
    expect(s.session.tools.map((t: any) => t.name)).toEqual(["registrar_resultado", "encerrar_ligacao"]);
  });
});

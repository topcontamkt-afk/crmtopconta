import { signVoiceToken, verifyVoiceToken } from "./voice";
import { AVISO_DESPEDIDA_SEG, ESPERA_DESPEDIDA_MS, VoiceBridge } from "./voiceBridge";

beforeAll(() => {
  process.env.JWT_SECRET = "segredo-de-teste";
  jest.useFakeTimers();
});
afterAll(() => jest.useRealTimers());

function setup(maxSeconds = 60) {
  const twilio: any[] = [];
  const xai: any[] = [];
  const logs: [string, any][] = [];
  const state = { opened: 0, hangup: 0 };
  const b = new VoiceBridge({
    verify: (t) => verifyVoiceToken(t),
    sendTwilio: (m) => twilio.push(m),
    sendXai: (m) => xai.push(m),
    openXai: () => state.opened++,
    hangup: () => state.hangup++,
    log: (e, d) => logs.push([e, d]),
    now: () => Date.now(),
    voice: "eve",
    maxSeconds,
  });
  const start = (token = signVoiceToken({ nome: "Maria", saldo: 100, ref: "r1" })) =>
    b.twilioMessage(JSON.stringify({ event: "start", start: { streamSid: "MZ1", callSid: "CA1", customParameters: { token } } }));
  return { b, twilio, xai, logs, state, start };
}

describe("VoiceBridge", () => {
  it("token inválido derruba a ligação sem abrir a xAI", () => {
    const s = setup();
    s.start("falso");
    expect(s.state.opened).toBe(0);
    expect(s.state.hangup).toBe(1);
  });

  it("start válido abre a xAI; ao conectar manda a sessão; ao confirmar o agente fala primeiro", () => {
    const s = setup();
    s.start();
    expect(s.state.opened).toBe(1);
    s.b.xaiOpen();
    expect(s.xai[0].type).toBe("session.update");
    expect(s.xai.some((m) => m.type === "response.create")).toBe(false);
    s.b.xaiMessage(JSON.stringify({ type: "session.updated" }));
    expect(s.xai[1]).toEqual({ type: "response.create" });
  });

  it("repassa áudio do cliente só depois da sessão pronta, e o áudio do agente para o Twilio", () => {
    const s = setup();
    s.start();
    s.b.xaiOpen();
    s.b.twilioMessage(JSON.stringify({ event: "media", media: { payload: "AAA", track: "inbound" } }));
    expect(s.xai.filter((m) => m.type === "input_audio_buffer.append")).toHaveLength(0);
    s.b.xaiMessage(JSON.stringify({ type: "session.updated" }));
    s.b.twilioMessage(JSON.stringify({ event: "media", media: { payload: "BBB", track: "inbound" } }));
    expect(s.xai.filter((m) => m.type === "input_audio_buffer.append")).toEqual([{ type: "input_audio_buffer.append", audio: "BBB" }]);
    s.b.xaiMessage(JSON.stringify({ type: "response.output_audio.delta", delta: "CCC" }));
    expect(s.twilio).toContainEqual({ event: "media", streamSid: "MZ1", media: { payload: "CCC" } });
    expect(s.logs.map((l) => l[0])).toContain("primeiro_audio");
  });

  it("quando o cliente fala por cima, limpa o áudio do agente ainda na fila do Twilio", () => {
    const s = setup();
    s.start();
    s.b.xaiOpen();
    s.b.xaiMessage(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
    expect(s.twilio).toContainEqual({ event: "clear", streamSid: "MZ1" });
  });

  it("registrar_resultado e encerrar_ligacao: despede e desliga só depois da fala", () => {
    const s = setup();
    s.start();
    s.b.xaiOpen();
    s.b.xaiMessage(JSON.stringify({ type: "session.updated" }));
    s.b.xaiMessage(JSON.stringify({ type: "response.function_call_arguments.done", call_id: "c1", name: "registrar_resultado", arguments: '{"resultado":"interessado","observacao":"quer saber"}' }));
    s.b.xaiMessage(JSON.stringify({ type: "response.function_call_arguments.done", call_id: "c2", name: "encerrar_ligacao", arguments: "{}" }));
    expect(s.xai.filter((m) => m.type === "conversation.item.create" && m.item.type === "function_call_output")).toHaveLength(2);
    expect(s.state.hangup).toBe(0);
    s.b.xaiMessage(JSON.stringify({ type: "response.done" }));
    jest.advanceTimersByTime(ESPERA_DESPEDIDA_MS + 10);
    expect(s.state.hangup).toBe(1);
    const fim = s.logs.find((l) => l[0] === "fim")![1];
    expect(fim).toMatchObject({ motivo: "agente_encerrou", resultado: "interessado", ref: "r1" });
  });

  it("avisa para se despedir perto do limite e corta no tempo máximo", () => {
    const s = setup(60);
    s.start();
    s.b.xaiOpen();
    s.b.xaiMessage(JSON.stringify({ type: "session.updated" }));
    jest.advanceTimersByTime((60 - AVISO_DESPEDIDA_SEG) * 1000 + 10);
    expect(s.xai.some((m) => m.type === "conversation.item.create" && JSON.stringify(m).includes("[SISTEMA]"))).toBe(true);
    jest.advanceTimersByTime(AVISO_DESPEDIDA_SEG * 1000 + 10);
    expect(s.state.hangup).toBe(1);
    expect(s.logs.find((l) => l[0] === "fim")![1].motivo).toBe("tempo_maximo");
  });

  it("stop do Twilio encerra uma vez só", () => {
    const s = setup();
    s.start();
    s.b.twilioMessage(JSON.stringify({ event: "stop" }));
    s.b.twilioMessage(JSON.stringify({ event: "stop" }));
    expect(s.state.hangup).toBe(1);
  });
});

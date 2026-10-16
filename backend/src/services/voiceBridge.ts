import { buildInstructions, buildSessionUpdate, VoiceTokenPayload } from "./voice";

/**
 * Ponte entre o Twilio Media Streams e o agente de voz da xAI, como máquina de estados sem rede: quem a usa
 * (`api/voice-bridge.ts`) injeta os envios e os timers. Assim dá para testar o fluxo sem abrir socket.
 *
 * Twilio -> ponte: connected | start | media | stop.   Ponte -> Twilio: media | clear.
 * Ponte -> xAI: session.update | input_audio_buffer.append | conversation.item.create | response.create.
 * xAI -> ponte: session.updated | response.output_audio.delta | input_audio_buffer.speech_started | function_call... | error.
 */

export interface VoiceBridgeDeps {
  verify(token: unknown): VoiceTokenPayload | null;
  sendTwilio(msg: Record<string, unknown>): void;
  sendXai(msg: Record<string, unknown>): void;
  /** abre a conexão com a xAI (a ponte chama depois de validar o token) */
  openXai(): void;
  /** derruba a ligação (fechar o WebSocket do Twilio encerra a chamada) */
  hangup(): void;
  log(event: string, data?: Record<string, unknown>): void;
  now(): number;
  voice: string;
  maxSeconds: number;
  logTranscript?: boolean;
}

/** Quanto antes do limite o agente é avisado para se despedir. */
export const AVISO_DESPEDIDA_SEG = 12;
/** Depois de pedir para encerrar, quanto esperar a despedida terminar de tocar. */
export const ESPERA_DESPEDIDA_MS = 2000;
export const LIMITE_ENCERRAR_MS = 10000;

export class VoiceBridge {
  private streamSid: string | null = null;
  private ctx: VoiceTokenPayload | null = null;
  private xaiReady = false;
  private xaiOpened = false;
  private ended = false;
  private closing = false;
  private startedAt = 0;
  private t: Record<string, number> = {};
  private timers: ReturnType<typeof setTimeout>[] = [];
  private resultado: { resultado?: string; observacao?: string } = {};
  private turnos = 0;
  private transcript: string[] = [];

  constructor(private d: VoiceBridgeDeps) {}

  // ---------- Twilio ----------
  twilioMessage(raw: string) {
    if (this.ended) return;
    let m: any;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    switch (m.event) {
      case "start": {
        const ctx = this.d.verify(m.start?.customParameters?.token);
        if (!ctx) {
          this.d.log("token_invalido");
          return this.end("token_invalido");
        }
        this.ctx = ctx;
        this.streamSid = m.start.streamSid;
        this.startedAt = this.d.now();
        this.d.log("twilio_start", { ref: ctx.ref, callSid: m.start.callSid });
        this.d.openXai();
        this.after(this.d.maxSeconds * 1000, () => this.end("tempo_maximo"));
        this.after(Math.max(1, this.d.maxSeconds - AVISO_DESPEDIDA_SEG) * 1000, () => this.pedirDespedida());
        return;
      }
      case "media":
        // só repassa depois que a sessão da xAI está pronta (o agente fala primeiro)
        if (this.xaiReady && m.media?.track !== "outbound") this.d.sendXai({ type: "input_audio_buffer.append", audio: m.media.payload });
        return;
      case "stop":
        return this.end("twilio_stop");
    }
  }

  // ---------- xAI ----------
  xaiOpen() {
    if (!this.ctx || this.xaiOpened) return;
    this.xaiOpened = true;
    this.t.xaiOpen = this.d.now();
    this.d.sendXai(buildSessionUpdate({ voice: this.d.voice, instructions: buildInstructions(this.ctx, this.d.maxSeconds) }));
    // se a xAI não confirmar a sessão, segue mesmo assim (o erro aparece no log)
    this.after(4000, () => this.sessaoPronta("sem_confirmacao"));
  }

  xaiMessage(raw: string) {
    if (this.ended) return;
    let e: any;
    try {
      e = JSON.parse(raw);
    } catch {
      return;
    }
    switch (e.type) {
      case "session.updated":
        return this.sessaoPronta("session.updated");
      case "response.output_audio.delta":
        if (!this.t.primeiroAudio) {
          this.t.primeiroAudio = this.d.now();
          this.d.log("primeiro_audio", { aposStartMs: this.t.primeiroAudio - this.startedAt });
        }
        if (this.streamSid && e.delta) this.d.sendTwilio({ event: "media", streamSid: this.streamSid, media: { payload: e.delta } });
        return;
      case "input_audio_buffer.speech_started":
        // a pessoa começou a falar por cima: descarta o áudio do agente que ainda está na fila do Twilio
        this.turnos++;
        if (this.streamSid) this.d.sendTwilio({ event: "clear", streamSid: this.streamSid });
        return;
      case "response.function_call_arguments.done":
        return this.chamadaDeFuncao(e);
      case "response.done":
        if (this.closing) this.after(ESPERA_DESPEDIDA_MS, () => this.end("agente_encerrou"));
        return;
      case "conversation.item.input_audio_transcription.completed":
        if (this.d.logTranscript && e.transcript) this.transcript.push(`cliente: ${e.transcript}`);
        return;
      case "response.output_audio_transcript.done":
        if (this.d.logTranscript && e.transcript) this.transcript.push(`agente: ${e.transcript}`);
        return;
      case "error":
        this.d.log("xai_erro", { erro: e.error ?? e });
        return;
    }
  }

  private sessaoPronta(origem: string) {
    if (this.xaiReady || this.ended) return;
    this.xaiReady = true;
    this.t.sessaoPronta = this.d.now();
    this.d.log("sessao_pronta", { origem, aposStartMs: this.t.sessaoPronta - this.startedAt });
    // ligação de saída: o agente fala primeiro (cumprimenta e confirma com quem fala)
    this.d.sendXai({ type: "response.create" });
  }

  private chamadaDeFuncao(e: any) {
    let args: any = {};
    try {
      args = JSON.parse(e.arguments || "{}");
    } catch {}
    if (e.name === "registrar_resultado") {
      this.resultado = { resultado: String(args.resultado ?? ""), observacao: args.observacao ? String(args.observacao).slice(0, 300) : undefined };
      this.d.log("resultado", this.resultado);
      this.responderFuncao(e.call_id, { ok: true });
    } else if (e.name === "encerrar_ligacao") {
      this.closing = true;
      this.responderFuncao(e.call_id, { ok: true });
      this.after(LIMITE_ENCERRAR_MS, () => this.end("agente_encerrou"));
    } else {
      this.responderFuncao(e.call_id, { erro: "função desconhecida" });
    }
  }

  /** Devolve o resultado da função e pede nova resposta (para o encerramento, é a despedida; o fim vem no response.done). */
  private responderFuncao(callId: string, output: unknown) {
    this.d.sendXai({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) } });
    this.d.sendXai({ type: "response.create" });
  }

  private pedirDespedida() {
    if (this.ended || !this.xaiReady || this.closing) return;
    this.d.log("aviso_despedida");
    this.d.sendXai({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: "[SISTEMA] O tempo da ligação está acabando. Despeça-se agora, em uma frase, e encerre a ligação." }] },
    });
    this.d.sendXai({ type: "response.create" });
  }

  // ---------- fim ----------
  end(motivo: string) {
    if (this.ended) return;
    this.ended = true;
    this.timers.forEach(clearTimeout);
    this.d.log("fim", {
      motivo,
      ref: this.ctx?.ref,
      duracaoSeg: this.startedAt ? Math.round((this.d.now() - this.startedAt) / 1000) : 0,
      turnosCliente: this.turnos,
      ...this.resultado,
      ...(this.d.logTranscript && this.transcript.length ? { transcricao: this.transcript } : {}),
    });
    this.d.hangup();
  }

  get finished() {
    return this.ended;
  }

  private after(ms: number, fn: () => void) {
    this.timers.push(setTimeout(fn, ms));
  }
}

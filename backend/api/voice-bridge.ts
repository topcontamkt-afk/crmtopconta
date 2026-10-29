import http from "http";
import { WebSocket, WebSocketServer } from "ws";
import { verifyVoiceToken } from "../src/services/voice";
import { VoiceBridge } from "../src/services/voiceBridge";

/**
 * Função da Vercel que serve de ponte WebSocket: Twilio (Media Streams) <-> agente de voz da xAI.
 * Fica separada do Express de propósito (`api/index.ts`): só importa código puro, sem banco, para subir rápido
 * quando o cliente atende. A lógica da conversa está em services/voiceBridge.ts (testada sem rede).
 *
 * Variáveis: XAI_API_KEY (obrigatória), XAI_AGENT_ID (opcional: usa o agente salvo no console da xAI),
 * XAI_VOICE_MODEL (padrão grok-voice-latest), XAI_VOICE (padrão eve), VOICE_MAX_SECONDS (padrão 90),
 * VOICE_LOG_TRANSCRIPT=1 (grava a transcrição nos logs; por padrão não).
 */
const server = http.createServer((_req, res) => {
  res.statusCode = 426;
  res.end("WebSocket only");
});

const wss = new WebSocketServer({ server });

function xaiUrl(): string {
  const base = "wss://api.x.ai/v1/realtime";
  if (process.env.XAI_AGENT_ID) return `${base}?agent_id=${encodeURIComponent(process.env.XAI_AGENT_ID)}`;
  return `${base}?model=${encodeURIComponent(process.env.XAI_VOICE_MODEL || "grok-voice-latest")}`;
}

wss.on("connection", (twilioWs: WebSocket) => {
  let xaiWs: WebSocket | null = null;

  const bridge = new VoiceBridge({
    verify: (t) => verifyVoiceToken(t),
    sendTwilio: (m) => twilioWs.readyState === WebSocket.OPEN && twilioWs.send(JSON.stringify(m)),
    sendXai: (m) => xaiWs?.readyState === WebSocket.OPEN && xaiWs.send(JSON.stringify(m)),
    openXai: () => {
      const key = process.env.XAI_API_KEY;
      if (!key) {
        console.error("[voice] XAI_API_KEY não configurada");
        return bridge.end("sem_chave_xai");
      }
      xaiWs = new WebSocket(xaiUrl(), { headers: { Authorization: `Bearer ${key}` } });
      xaiWs.on("open", () => bridge.xaiOpen());
      xaiWs.on("message", (raw) => bridge.xaiMessage(raw.toString()));
      xaiWs.on("error", (e) => {
        console.error("[voice] erro na conexão com a xAI:", e.message);
        bridge.end("erro_xai");
      });
      xaiWs.on("close", () => bridge.end("xai_fechou"));
    },
    hangup: () => {
      try {
        xaiWs?.close();
      } catch {}
      // fechar o WebSocket do Twilio encerra a ligação
      try {
        twilioWs.close();
      } catch {}
    },
    log: (event, data) => console.log(`[voice] ${event}`, JSON.stringify(data ?? {})),
    now: () => Date.now(),
    voice: process.env.XAI_VOICE || "eve",
    maxSeconds: Number(process.env.VOICE_MAX_SECONDS) || 90,
    logTranscript: process.env.VOICE_LOG_TRANSCRIPT === "1",
  });

  twilioWs.on("message", (raw) => bridge.twilioMessage(raw.toString()));
  twilioWs.on("close", () => bridge.end("twilio_fechou"));
  twilioWs.on("error", () => bridge.end("erro_twilio"));
});

export default server;

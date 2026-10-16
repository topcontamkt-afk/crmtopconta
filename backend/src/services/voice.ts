import crypto from "crypto";

/**
 * Ligação com agente de voz (IA): partes puras, sem rede e sem banco. O CRM manda o Twilio ligar; ao atender, o Twilio
 * abre um WebSocket (Media Streams) com a ponte (`api/voice-bridge.ts`), que repassa o áudio para o agente de voz da xAI.
 *
 * O endpoint da ponte é público (o Twilio não se autentica na Vercel), então o que a ponte confia vem num TOKEN assinado
 * (HMAC) que só o CRM sabe gerar: contém o contexto da ligação (nome, saldo...) e expira em poucos minutos.
 */

export interface VoiceCallContext {
  nome: string;
  /** saldo disponível a falar na ligação (R$); null = não mencionar valor */
  saldo?: number | null;
  cidade?: string;
  /** identificador interno da ligação (aparece nos logs) */
  ref: string;
}

export interface VoiceTokenPayload extends VoiceCallContext {
  exp: number; // epoch em segundos
}

const key = () => crypto.createHash("sha256").update(`voice-call:${process.env.JWT_SECRET ?? ""}`).digest();
const mac = (body: string) => crypto.createHmac("sha256", key()).update(body).digest("base64url");

export const VOICE_TOKEN_TTL_SEC = 600;

export function signVoiceToken(ctx: VoiceCallContext, nowMs: number = Date.now(), ttlSec = VOICE_TOKEN_TTL_SEC): string {
  const payload: VoiceTokenPayload = { ...ctx, exp: Math.floor(nowMs / 1000) + ttlSec };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${mac(body)}`;
}

export function verifyVoiceToken(token: unknown, nowMs: number = Date.now()): VoiceTokenPayload | null {
  if (typeof token !== "string" || token.length > 4000) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = Buffer.from(mac(body));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as VoiceTokenPayload;
    if (typeof p.exp !== "number" || p.exp * 1000 < nowMs) return null;
    if (typeof p.nome !== "string" || typeof p.ref !== "string") return null;
    return p;
  } catch {
    return null;
  }
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** TwiML enviado direto na criação da chamada: ao atender, conecta o áudio à ponte (wss) levando o token. */
export function buildTwiml(streamUrl: string, token: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xmlEscape(streamUrl)}"><Parameter name="token" value="${xmlEscape(token)}"/></Stream></Connect></Response>`;
}

/** https://host -> wss://host/api/voice-bridge */
export function bridgeUrl(publicBackend: string): string {
  return `${publicBackend.replace(/\/+$/, "").replace(/^http/i, "ws")}/api/voice-bridge`;
}

const brl = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export const VOICE_TOOLS = [
  {
    type: "function",
    name: "registrar_resultado",
    description: "Registra como terminou a conversa. Chame uma vez, perto do fim da ligação.",
    parameters: {
      type: "object",
      properties: {
        resultado: { type: "string", enum: ["interessado", "sem_interesse", "pessoa_errada", "pediu_para_nao_ligar", "sem_resposta"] },
        observacao: { type: "string", description: "Uma frase curta com o que a pessoa disse." },
      },
      required: ["resultado"],
    },
  },
  {
    type: "function",
    name: "encerrar_ligacao",
    description: "Encerra a ligação depois de você se despedir. Chame logo após a despedida.",
    parameters: { type: "object", properties: { motivo: { type: "string" } } },
  },
] as const;

/** Instruções do agente (português do Brasil). O saldo só é dito depois de confirmar com quem está falando. */
export function buildInstructions(ctx: VoiceCallContext, maxSeconds: number): string {
  const temSaldo = typeof ctx.saldo === "number" && ctx.saldo > 0;
  return [
    `Você é a assistente virtual da TopConta, uma empresa de cartão de benefícios. Você está FAZENDO uma ligação para ${ctx.nome}${ctx.cidade ? ` (${ctx.cidade})` : ""}. Fale português do Brasil, de forma simpática, natural e bem curta.`,
    `Objetivo: ${temSaldo ? `avisar que ${ctx.nome} tem ${brl(ctx.saldo as number)} de limite disponível no cartão e incentivar a usar o serviço` : `avisar que o serviço do cartão está disponível e incentivar o uso`}.`,
    `Roteiro:`,
    `1. Quando a ligação começar, diga: "Olá, tudo bem? Falo com ${ctx.nome}?" e espere a resposta. Se a pessoa disser "alô", apresente-se e pergunte de novo.`,
    `2. Só depois de a pessoa confirmar que é ${ctx.nome}, diga que você é a assistente virtual da TopConta${temSaldo ? ` e que ele(a) tem ${brl(ctx.saldo as number)} disponível para usar` : ""}.`,
    `3. Faça UMA proposta simples: pergunte se quer saber como usar. Não explique demais; responda dúvidas em poucas frases.`,
    `4. Se a pessoa não for ${ctx.nome}, peça desculpas, não revele nada sobre a conta (nem o saldo) e encerre.`,
    `5. Se pedir para não receber mais ligações, confirme com gentileza, registre o resultado "pediu_para_nao_ligar" e encerre.`,
    `Regras: nunca peça CPF, senha, código ou dados de cartão; não faça promessas que você não conhece; se não souber, diga que a equipe retornará. A ligação deve durar no máximo ${maxSeconds} segundos: seja objetiva.`,
    `Ao terminar, chame registrar_resultado e depois, após se despedir, chame encerrar_ligacao.`,
  ].join("\n");
}

export interface VoiceSessionSettings {
  voice: string;
  instructions: string;
}

/** session.update da xAI: áudio G.711 μ-law 8 kHz nos dois sentidos (o mesmo do Twilio, sem conversão), detecção de turno no servidor. */
export function buildSessionUpdate(s: VoiceSessionSettings) {
  return {
    type: "session.update",
    session: {
      instructions: s.instructions,
      voice: s.voice,
      turn_detection: { type: "server_vad" },
      audio: {
        input: { format: { type: "audio/pcmu" }, transcription: { model: "grok-transcribe", language_hint: "pt-BR" } },
        output: { format: { type: "audio/pcmu" } },
      },
      tools: VOICE_TOOLS,
    },
  };
}

import crypto from "crypto";
import express, { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../middleware/audit";
import { maskPhone, normalizePhone } from "../services/masking";
import { bridgeUrl, buildInboundTwiml, buildTwiml, signVoiceToken } from "../services/voice";
import { verifyTwilioSignature } from "../services/webhookAuth";

/**
 * Ligação com agente de voz (fase 1: só teste). O CRM pede ao Twilio para ligar; ao atender, o Twilio conecta o áudio à
 * ponte (`api/voice-bridge.ts`). Nesta fase o destino é SEMPRE o celular de teste (`VOICE_TEST_NUMBER`), nunca um número
 * vindo da tela, para não ligar para cliente sem querer.
 */
const publicBackend = () => (process.env.PUBLIC_BACKEND_URL || "https://crmtopconta-backend.vercel.app").replace(/\/+$/, "");
const fromNumber = () => process.env.TWILIO_VOICE_NUMBER || process.env.TWILIO_FROM_NUMBER;
const maxSeconds = () => Number(process.env.VOICE_MAX_SECONDS) || 90;

function configuracao() {
  const teste = process.env.VOICE_TEST_NUMBER ? normalizePhone(process.env.VOICE_TEST_NUMBER) : null;
  return {
    twilio: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && fromNumber()),
    xai: !!process.env.XAI_API_KEY,
    numeroTeste: teste ? maskPhone(teste) : null,
    destino: teste,
  };
}

const router = Router();
router.use(requireAuth);

/** GET /api/voice/status — o que já está configurado (nunca devolve chaves nem o número inteiro). */
router.get("/status", requireRole("ADMIN", "OPERATOR"), (_req, res) => {
  const c = configuracao();
  res.json({ twilio: c.twilio, xai: c.xai, numeroTeste: c.numeroTeste, pronto: c.twilio && c.xai && !!c.destino, maxSegundos: maxSeconds() });
});

// Freio simples contra clique repetido (por instância; o Twilio e o limite de 3 por hora já protegem o custo)
const ultimas = new Map<string, number[]>();
function liberado(tenantId: string): boolean {
  const agora = Date.now();
  const lista = (ultimas.get(tenantId) ?? []).filter((t) => agora - t < 3600_000);
  if (lista.length >= 3) return false;
  lista.push(agora);
  ultimas.set(tenantId, lista);
  return true;
}

const testSchema = z.object({
  nome: z.string().trim().min(1).max(60).default("Cliente teste"),
  saldo: z.number().min(0).max(1_000_000).nullable().optional(),
});

/** POST /api/voice/test-call (ADMIN) — liga para o celular de teste com nome e saldo informados. */
router.post("/test-call", requireRole("ADMIN"), async (req, res) => {
  const parsed = testSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: userId } = req.user!;
  const c = configuracao();
  if (!c.twilio) return res.status(409).json({ error: "Twilio não configurado (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN e TWILIO_VOICE_NUMBER)." });
  if (!c.xai) return res.status(409).json({ error: "Chave da xAI não configurada (XAI_API_KEY)." });
  if (!c.destino) return res.status(409).json({ error: "Celular de teste não configurado (VOICE_TEST_NUMBER, com DDD)." });
  if (!liberado(tenantId)) return res.status(429).json({ error: "Limite de 3 ligações de teste por hora." });

  const ref = crypto.randomBytes(6).toString("hex");
  const token = signVoiceToken({ nome: parsed.data.nome, saldo: parsed.data.saldo ?? null, ref });
  const twiml = buildTwiml(bridgeUrl(publicBackend()), token);

  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const form = new URLSearchParams({
    To: c.destino,
    From: fromNumber()!,
    Twiml: twiml,
    Timeout: "25",
    TimeLimit: String(maxSeconds() + 15),
    StatusCallback: `${publicBackend()}/api/voice/twilio-status`,
  });
  for (const ev of ["initiated", "ringing", "answered", "completed"]) form.append("StatusCallbackEvent", ev);

  try {
    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    const json: any = await resp.json();
    if (!resp.ok) return res.status(502).json({ error: `O Twilio recusou a ligação: ${json.message || resp.status}`, codigo: json.code });
    await logAudit({ tenantId, userId, action: "VOICE_TEST_CALL", target: "Call", targetId: json.sid, details: { ref } });
    res.status(201).json({ ok: true, ref, callSid: json.sid, status: json.status, destino: c.numeroTeste });
  } catch (e: any) {
    res.status(502).json({ error: `Não consegui falar com o Twilio: ${e.message}` });
  }
});

export default router;

/** Webhook público do Twilio com o andamento da chamada (toca, atendeu, terminou). Valida a assinatura X-Twilio-Signature. */
export const voiceWebhook = Router();
/** Confere a assinatura X-Twilio-Signature (mesma URL pública que o Twilio chamou). */
function assinaturaValida(req: express.Request): boolean {
  const token = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.headers["x-twilio-signature"] as string | undefined;
  if (!token) return false;
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] || req.protocol;
  const host = (req.headers["x-forwarded-host"] as string | undefined) || req.get("host") || "";
  return verifyTwilioSignature(`${proto}://${host}${req.originalUrl}`, req.body as Record<string, string>, signature, token);
}

/**
 * Webhook de ligação RECEBIDA (configurado no número do Twilio em "A call comes in"). Só atende o celular de teste: devolve
 * o TwiML que conecta o áudio à ponte; para qualquer outro número, <Reject/>.
 */
voiceWebhook.post("/inbound", express.urlencoded({ extended: false }), (req, res) => {
  if (!assinaturaValida(req)) return res.sendStatus(401);
  const from = (req.body as Record<string, string>).From;
  const ref = crypto.randomBytes(6).toString("hex");
  const nome = process.env.VOICE_TEST_NAME || "Maria";
  const saldoEnv = process.env.VOICE_TEST_SALDO;
  const saldo = saldoEnv === undefined || saldoEnv === "" ? 250 : Number(saldoEnv);
  const token = signVoiceToken({ nome, saldo: Number.isFinite(saldo) ? saldo : null, ref });
  const teste = process.env.VOICE_TEST_NUMBER ? normalizePhone(process.env.VOICE_TEST_NUMBER) : null;
  const twiml = buildInboundTwiml({ from, testNumber: teste, streamUrl: bridgeUrl(publicBackend()), token });
  console.log("[voice] ligacao_recebida", JSON.stringify({ ref, aceita: twiml.includes("<Connect>"), de: from ? maskPhone(from) : null }));
  res.type("text/xml").send(twiml);
});

voiceWebhook.post("/twilio-status", express.urlencoded({ extended: false }), (req, res) => {
  const token = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.headers["x-twilio-signature"] as string | undefined;
  if (!token) return res.sendStatus(401);
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] || req.protocol;
  const host = (req.headers["x-forwarded-host"] as string | undefined) || req.get("host") || "";
  if (!verifyTwilioSignature(`${proto}://${host}${req.originalUrl}`, req.body as Record<string, string>, signature, token)) return res.sendStatus(401);
  const { CallSid, CallStatus, CallDuration, SipResponseCode } = req.body as Record<string, string>;
  console.log("[voice] status", JSON.stringify({ CallSid, CallStatus, CallDuration, SipResponseCode }));
  res.sendStatus(204);
});

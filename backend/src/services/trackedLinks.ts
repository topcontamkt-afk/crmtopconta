import crypto from "crypto";
import { publicBackendUrl } from "../config/publicUrl";

/**
 * Link rastreado de botão de template. O que a Meta aprova é `https://<nosso domínio>/r/{{1}}`; a cada
 * envio o `{{1}}` vira um código assinado daquela mensagem. Ao tocar, `routes/trackedLinks.ts` registra o
 * clique e redireciona para o DESTINO REAL, que fica só aqui (no botão do template, `tracked: true`) e
 * pode mudar sem pedir nova aprovação. Código = tipo(1) + id(32 hex) + índice do botão(1 hex) + assinatura(11).
 *  - tipo "e": id da MessageEvent (campanha) → o clique entra no relatório;
 *  - tipo "n": id do template (envio de teste/Inbox) → só redireciona, sem registrar.
 */

export const TOKEN_LENGTH = 45;

export type TokenKind = "e" | "n";

/** Domínio dos links (sem barra no fim): LINK_BASE_URL, senão PUBLIC_BACKEND_URL; null sem nenhuma das duas. */
export function linkBase(): string | null {
  const url = process.env.LINK_BASE_URL?.trim() || publicBackendUrl();
  return url ? url.replace(/\/+$/, "") : null;
}

function secretKey(secret?: string): Buffer {
  return crypto.createHash("sha256").update(`track-link:${secret ?? process.env.JWT_SECRET ?? ""}`).digest();
}

const sign = (payload: string, secret?: string) => crypto.createHmac("sha256", secretKey(secret)).update(payload).digest("base64url").slice(0, 11);

export function makeToken(kind: TokenKind, id: string, buttonIndex: number, secret?: string): string {
  const hex = id.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error("id inválido para o link rastreado");
  if (!Number.isInteger(buttonIndex) || buttonIndex < 0 || buttonIndex > 15) throw new Error("índice de botão inválido");
  const payload = `${kind}${hex}${buttonIndex.toString(16)}`;
  return payload + sign(payload, secret);
}

export interface ParsedToken {
  kind: TokenKind;
  id: string; // uuid com hífens
  buttonIndex: number;
}

export function parseToken(token: string, secret?: string): ParsedToken | null {
  if (typeof token !== "string" || token.length !== TOKEN_LENGTH) return null;
  const payload = token.slice(0, 34);
  const m = /^([en])([0-9a-f]{32})([0-9a-f])$/.exec(payload);
  if (!m) return null;
  const expected = Buffer.from(sign(payload, secret));
  const got = Buffer.from(token.slice(34));
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return null;
  const h = m[2];
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  return { kind: m[1] as TokenKind, id, buttonIndex: parseInt(m[3], 16) };
}

export interface TrackedButton {
  /** posição do botão no template enviado à Meta (respostas rápidas vêm antes dos botões de ação) */
  index: number;
  text: string;
  url: string; // destino real
}

/** Botões de link rastreados de um template, com o índice que a Meta usa no envio. */
export function trackedButtons(t: { quickReplies?: unknown; buttons?: unknown }): TrackedButton[] {
  const quick = Array.isArray(t.quickReplies) ? (t.quickReplies as unknown[]).filter(Boolean).length : 0;
  const ctas = Array.isArray(t.buttons) ? (t.buttons as { type?: string; text?: string; url?: string; tracked?: boolean }[]) : [];
  const out: TrackedButton[] = [];
  ctas.forEach((b, i) => {
    if (b?.type === "URL" && b.tracked && b.url) out.push({ index: quick + i, text: String(b.text ?? ""), url: b.url });
  });
  return out;
}

/** Endereço que vai para a Meta no template: o destino real não aparece lá. */
export const trackedUrlPattern = (base: string) => `${base.replace(/\/+$/, "")}/r/{{1}}`;
export const trackedUrlExample = (base: string) => `${base.replace(/\/+$/, "")}/r/${"a".repeat(TOKEN_LENGTH)}`;

/** Prévia de link do WhatsApp, antivírus e robôs abrem links sozinhos: não contam como clique de gente. */
export function isBotUserAgent(ua: string | undefined): boolean {
  if (!ua) return true;
  return /bot|crawler|spider|preview|facebookexternalhit|whatsapp|telegram|slack|curl|wget|python-requests|headless|monitor|scanner|googleother|bingpreview/i.test(ua);
}

/**
 * Pré-requisitos da WhatsApp Business Calling API (Meta) que dá para conferir pela Graph API, em
 * funções puras: limite diário de mensagens (a Meta exige 2.000 destinatários únicos) e se o recurso de
 * ligações já está ligado no número. Só diagnóstico: nenhuma ligação passa por aqui ainda.
 */
export const CALLING_MIN_RECIPIENTS = 2000;

/** "TIER_10K" -> 10000; "TIER_UNLIMITED" -> Infinity; formato desconhecido -> null. */
export function tierRecipients(tier: string | null | undefined): number | null {
  const t = String(tier ?? "").trim().toUpperCase();
  if (!t) return null;
  if (t.includes("UNLIMITED")) return Infinity;
  const m = /^TIER_(\d+(?:\.\d+)?)([KM])?$/.exec(t);
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2] === "K" ? 1_000 : m[2] === "M" ? 1_000_000 : 1));
}

export interface CallingCheck {
  nome: string;
  /** null = não deu para saber (a Meta não devolveu o campo) */
  ok: boolean | null;
  detalhe: string;
}

export function callingChecks(input: { tier?: string | null; callingStatus?: string | null; tierError?: string; callingError?: string }): CallingCheck[] {
  const out: CallingCheck[] = [];

  const n = tierRecipients(input.tier);
  if (input.tierError) out.push({ nome: "Limite diário de mensagens", ok: null, detalhe: `Não consegui ler: ${input.tierError}` });
  else if (n === null) out.push({ nome: "Limite diário de mensagens", ok: null, detalhe: input.tier ? `Nível desconhecido (${input.tier}). Confira no WhatsApp Manager.` : "A Meta não informou o nível. Confira no WhatsApp Manager." });
  else if (n >= CALLING_MIN_RECIPIENTS) out.push({ nome: "Limite diário de mensagens", ok: true, detalhe: `${input.tier} (${n === Infinity ? "sem limite" : `${n.toLocaleString("pt-BR")} por dia`}) — atende o mínimo de ${CALLING_MIN_RECIPIENTS.toLocaleString("pt-BR")}.` });
  else out.push({ nome: "Limite diário de mensagens", ok: false, detalhe: `${input.tier} (${n.toLocaleString("pt-BR")} por dia) — a Meta exige pelo menos ${CALLING_MIN_RECIPIENTS.toLocaleString("pt-BR")} destinatários únicos por dia para liberar ligações.` });

  const s = String(input.callingStatus ?? "").toUpperCase();
  if (input.callingError) out.push({ nome: "Ligações ligadas no número", ok: null, detalhe: `Não consegui ler: ${input.callingError}` });
  else if (s === "ENABLED") out.push({ nome: "Ligações ligadas no número", ok: true, detalhe: "O recurso de ligações já está ligado." });
  else out.push({ nome: "Ligações ligadas no número", ok: false, detalhe: "Desligado (é o padrão). Precisa ser ligado nas configurações de ligação do número." });

  return out;
}

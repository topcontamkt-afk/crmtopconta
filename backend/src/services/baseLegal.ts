/**
 * LGPD 02-01: base legal das mensagens de marketing, declarada pelo controlador (cada tenant) em
 * Configurações → LGPD. Sem base declarada (`Tenant.baseLegalMarketing` nulo), nenhum envio de marketing sai:
 * campanha de segmento, lista manual e automação passam todas por `processQueueBatch`/`enqueueCampaign`, que
 * conferem aqui. A escolha da base é decisão do controlador; o sistema só registra e cobra a declaração.
 */

export const BASES_LEGAIS = ["LEGITIMO_INTERESSE", "CONSENTIMENTO"] as const;
export type BaseLegal = (typeof BASES_LEGAIS)[number];

export const BASE_LEGAL_LABEL: Record<BaseLegal, string> = {
  LEGITIMO_INTERESSE: "Legítimo interesse (art. 7º, IX)",
  CONSENTIMENTO: "Consentimento (art. 7º, I)",
};

/** Mensagem única do bloqueio (API, assistente, fila e automação). */
export const SEM_BASE_LEGAL =
  "Envio de marketing bloqueado: a empresa ainda não declarou a base legal das mensagens. Declare a base legal em Configurações → LGPD.";

export function isBaseLegal(v: unknown): v is BaseLegal {
  return typeof v === "string" && (BASES_LEGAIS as readonly string[]).includes(v);
}

/** Base legal vigente do tenant, ou null (envio bloqueado). Valor desconhecido também conta como não declarado. */
export function baseLegalVigente(t: { baseLegalMarketing?: string | null } | null | undefined): BaseLegal | null {
  return isBaseLegal(t?.baseLegalMarketing) ? t!.baseLegalMarketing : null;
}

/** Motivo do bloqueio por falta de base legal, ou null quando pode enviar. */
export function motivoSemBaseLegal(t: { baseLegalMarketing?: string | null } | null | undefined): string | null {
  return baseLegalVigente(t) ? null : SEM_BASE_LEGAL;
}

/** Legítimo interesse sem LIA aprovada (versão e data): o envio segue, mas o assistente avisa. */
export function liaPendente(t: { baseLegalMarketing?: string | null; liaVersao?: string | null; liaAprovadaEm?: Date | string | null }): boolean {
  return baseLegalVigente(t) === "LEGITIMO_INTERESSE" && (!t.liaVersao?.trim() || !t.liaAprovadaEm);
}

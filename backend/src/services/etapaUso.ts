/**
 * Etapa de uso do cliente, calculada do EXTRATO de transações (Purchase), não do snapshot do
 * cliente: só antecipação (Débito Pix Cartão) e compra à vista contam (ver transactionClassifier.ts).
 * Assinatura, débito de fatura e descrições desconhecidas nunca entram.
 *
 * Três colunas em Client (refeitas por services/usageRefresh.ts a cada importação de compras e
 * uma vez por dia, porque a janela de 90 dias anda sozinha):
 *   ultimoUsoReal   — data da transação de uso mais recente
 *   usosUltimos90d  — quantos usos nos últimos 90 dias
 *   usosTotal       — quantos usos no extrato inteiro
 *
 * Etapas (cortes como constantes aqui; mudar um corte muda segmentos e dashboard na hora):
 *   NUNCA_USOU   nenhum uso no extrato
 *   RECORRENTE   usou nos últimos 30 dias e tem 3+ usos em 90 dias
 *   OCASIONAL    usou nos últimos 30 dias, com 1–2 usos em 90 dias
 *   EM_RISCO     último uso há 31–90 dias
 *   INATIVO      último uso há mais de 90 dias
 *
 * Atenção: "NUNCA_USOU" vale para o período coberto pelo extrato enviado. Se o extrato começa em
 * outubro, quem usou em agosto aparece como nunca usou — o aviso de cobertura fica no dashboard.
 */
import type { Prisma } from "@prisma/client";

export const ETAPAS_USO = ["NUNCA_USOU", "RECORRENTE", "OCASIONAL", "EM_RISCO", "INATIVO"] as const;
export type EtapaUso = (typeof ETAPAS_USO)[number];

export const DIAS_RECENTE = 30;
export const DIAS_RISCO = 90;
export const USOS_RECORRENTE = 3;
export const JANELA_USOS_DIAS = 90;

export const ETAPA_LABELS: Record<EtapaUso, string> = {
  NUNCA_USOU: "Nunca usou",
  RECORRENTE: "Recorrente (3+ usos em 90 dias)",
  OCASIONAL: "Ocasional (1–2 usos em 90 dias)",
  EM_RISCO: "Em risco (último uso há 31–90 dias)",
  INATIVO: "Inativo (sem uso há mais de 90 dias)",
};

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (now: Date, d: number) => new Date(now.getTime() - d * DAY_MS);

export function classificarEtapa(
  c: { ultimoUsoReal: Date | null | undefined; usosUltimos90d: number; usosTotal: number },
  now = new Date()
): EtapaUso {
  if (!c.ultimoUsoReal || c.usosTotal <= 0) return "NUNCA_USOU";
  const dias = (now.getTime() - c.ultimoUsoReal.getTime()) / DAY_MS;
  if (dias <= DIAS_RECENTE) return c.usosUltimos90d >= USOS_RECORRENTE ? "RECORRENTE" : "OCASIONAL";
  if (dias <= DIAS_RISCO) return "EM_RISCO";
  return "INATIVO";
}

/** Filtro do banco equivalente a classificarEtapa. */
export function etapaWhere(etapa: EtapaUso, now = new Date()): Prisma.ClientWhereInput {
  const recente = daysAgo(now, DIAS_RECENTE);
  const risco = daysAgo(now, DIAS_RISCO);
  switch (etapa) {
    case "NUNCA_USOU":
      return { OR: [{ ultimoUsoReal: null }, { usosTotal: 0 }] };
    case "RECORRENTE":
      return { ultimoUsoReal: { gte: recente }, usosUltimos90d: { gte: USOS_RECORRENTE } };
    case "OCASIONAL":
      return { ultimoUsoReal: { gte: recente }, usosUltimos90d: { lt: USOS_RECORRENTE } };
    case "EM_RISCO":
      return { ultimoUsoReal: { lt: recente, gte: risco } };
    case "INATIVO":
      return { ultimoUsoReal: { lt: risco } };
  }
}

export function isEtapaUso(v: unknown): v is EtapaUso {
  return typeof v === "string" && (ETAPAS_USO as readonly string[]).includes(v);
}

/** CASE SQL com a mesma regra (para o dashboard). Cortes são constantes do código, não entrada. */
export const ETAPA_CASE_SQL = `CASE
  WHEN "ultimoUsoReal" IS NULL OR "usosTotal" <= 0 THEN 'NUNCA_USOU'
  WHEN "ultimoUsoReal" >= now() - interval '${DIAS_RECENTE} days' AND "usosUltimos90d" >= ${USOS_RECORRENTE} THEN 'RECORRENTE'
  WHEN "ultimoUsoReal" >= now() - interval '${DIAS_RECENTE} days' THEN 'OCASIONAL'
  WHEN "ultimoUsoReal" >= now() - interval '${DIAS_RISCO} days' THEN 'EM_RISCO'
  ELSE 'INATIVO'
END`;

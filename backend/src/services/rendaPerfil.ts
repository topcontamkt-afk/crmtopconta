/**
 * Perfil de renda PF1–PF4, estimado a partir do LIMITE do cartão (decisão do cliente, 2026-10-10).
 *
 * Regra: o limite total é 40% do salário, então salário estimado = limite ÷ 0,40. Usa o limite
 * TOTAL, nunca o saldo disponível (que cai a cada uso e distorceria a renda). Os cortes abaixo
 * são os do cliente:
 *   PF1  até R$ 4.000        (inclui quem estaria abaixo do piso de R$ 1.621 — decisão do cliente)
 *   PF2  R$ 4.001 a 8.000
 *   PF3  R$ 8.001 a 12.000
 *   PF4  R$ 12.001 a 100.000 (acima disso também fica em PF4)
 *
 * Sem limite (zero ou vazio) = comércio credenciado: não é cliente de consumo, não tem perfil e
 * não recebe disparo (ver ENVIAVEL_WHERE em segments.ts).
 *
 * Limitação conhecida: o limite tem um TETO de R$ 2.000. Quem está exatamente no teto ganha pelo
 * menos R$ 5.000, mas não dá para saber quanto acima — por isso PF3/PF4 aparecem quase vazios.
 * `isNoTeto` marca esses clientes (continuam em PF2). Quando houver o salário real (aba
 * "SaldoCartao"), ele deve substituir esta estimativa.
 *
 * Tudo é calculado na hora, sem coluna nova no banco: mudar o fator ou um corte aqui muda os
 * segmentos na próxima contagem.
 */

export const FATOR_LIMITE_SALARIO = 0.4;
export const LIMITE_TETO = 2000;

export const PERFIS_RENDA = ["PF1", "PF2", "PF3", "PF4"] as const;
export type PerfilRenda = (typeof PERFIS_RENDA)[number];

/** Teto SALARIAL de cada perfil (PF4 não tem teto: o cliente definiu 100 mil só como referência). */
export const SALARIO_MAXIMO: Record<Exclude<PerfilRenda, "PF4">, number> = {
  PF1: 4000,
  PF2: 8000,
  PF3: 12000,
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Teto de LIMITE de cada perfil (= teto salarial × fator). As comparações são feitas no domínio do
 * limite, não do salário, para não depender de arredondamento de ponto flutuante (1600 ÷ 0,4).
 */
export const LIMITE_MAXIMO: Record<Exclude<PerfilRenda, "PF4">, number> = {
  PF1: round2(SALARIO_MAXIMO.PF1 * FATOR_LIMITE_SALARIO), // 1.600
  PF2: round2(SALARIO_MAXIMO.PF2 * FATOR_LIMITE_SALARIO), // 3.200
  PF3: round2(SALARIO_MAXIMO.PF3 * FATOR_LIMITE_SALARIO), // 4.800
};

export const PERFIL_LABELS: Record<PerfilRenda, string> = {
  PF1: "PF1 (até R$ 4.000)",
  PF2: "PF2 (R$ 4.001 a 8.000)",
  PF3: "PF3 (R$ 8.001 a 12.000)",
  PF4: "PF4 (R$ 12.001 a 100.000)",
};

function toNumber(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Salário estimado a partir do limite; null quando não há limite (comércio credenciado). */
export function estimarSalario(limite: unknown): number | null {
  const l = toNumber(limite);
  if (l <= 0) return null;
  return round2(l / FATOR_LIMITE_SALARIO);
}

/** Perfil de renda do limite; null quando não há limite (comércio credenciado). */
export function classificarPerfil(limite: unknown): PerfilRenda | null {
  const l = toNumber(limite);
  if (l <= 0) return null;
  if (l <= LIMITE_MAXIMO.PF1) return "PF1";
  if (l <= LIMITE_MAXIMO.PF2) return "PF2";
  if (l <= LIMITE_MAXIMO.PF3) return "PF3";
  return "PF4";
}

/** Limite exatamente no teto de R$ 2.000: a renda real não aparece (é "R$ 5.000 ou mais"). */
export function isNoTeto(limite: unknown): boolean {
  return Math.abs(toNumber(limite) - LIMITE_TETO) < 0.005;
}

/**
 * Intervalo de LIMITE de um perfil, como `gt`/`lte` (o intervalo é aberto embaixo e fechado em
 * cima, igual a classificarPerfil: um limite pertence a exatamente um perfil). Usado para montar o
 * filtro do banco sem coluna nova.
 */
export function limiteRange(perfil: PerfilRenda): { gt: number; lte?: number } {
  switch (perfil) {
    case "PF1":
      return { gt: 0, lte: LIMITE_MAXIMO.PF1 };
    case "PF2":
      return { gt: LIMITE_MAXIMO.PF1, lte: LIMITE_MAXIMO.PF2 };
    case "PF3":
      return { gt: LIMITE_MAXIMO.PF2, lte: LIMITE_MAXIMO.PF3 };
    case "PF4":
      return { gt: LIMITE_MAXIMO.PF3 };
  }
}

export function isPerfilRenda(v: unknown): v is PerfilRenda {
  return typeof v === "string" && (PERFIS_RENDA as readonly string[]).includes(v);
}

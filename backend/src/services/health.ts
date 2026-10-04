/**
 * Nota de saúde da base (0-100), calculada no servidor para que tela, exports e histórico usem
 * exatamente a mesma regra. Cada componente vira uma nota de 0 a 100 e entra com um peso:
 *
 *  - Ativação (40): % de clientes ativos, contra uma meta de 60% (acima da meta = nota cheia).
 *  - Alcance (20): % de clientes COM limite cadastrado que já usaram o cartão alguma vez
 *    (clientes sem limite — faixa INDEFINIDO — ficam fora: não dá para dizer que "não usaram").
 *  - Uso do limite (25): % do limite liberado que está em uso, contra uma meta de 40%.
 *  - Regularidade (15): 100 menos o % de clientes bloqueados.
 *
 * Metas e pesos são constantes exportadas (não "mágicas" espalhadas) para poderem virar
 * configuração por tenant depois sem mudar quem chama.
 */

export const HEALTH_TARGETS = { ativacao: 0.6, usoLimite: 0.4 };
export const HEALTH_WEIGHTS = { ativacao: 40, alcance: 20, usoLimite: 25, regularidade: 15 };

export interface HealthInput {
  total: number;
  ativos: number;
  semUso: number;
  /** Clientes sem limite cadastrado (faixa INDEFINIDO). Opcional; padrão 0. */
  indefinidos?: number;
  bloqueados: number;
  limiteTotal: number;
  valorUtilizado: number;
}

export type HealthBand = "SAUDAVEL" | "ATENCAO" | "CRITICO";

export interface HealthComponent {
  key: "ativacao" | "alcance" | "usoLimite" | "regularidade";
  label: string;
  peso: number;
  nota: number; // 0-100
  valor: number; // 0-100, métrica bruta em %
  meta: number | null; // meta em %, quando existe
}

export interface HealthResult {
  score: number;
  band: HealthBand;
  bandLabel: string;
  components: HealthComponent[];
}

const clamp = (n: number, min = 0, max = 100) => Math.min(max, Math.max(min, n));
const round1 = (n: number) => Math.round(n * 10) / 10;

export function bandFor(score: number): { band: HealthBand; label: string } {
  if (score >= 70) return { band: "SAUDAVEL", label: "Saudável" };
  if (score >= 40) return { band: "ATENCAO", label: "Atenção" };
  return { band: "CRITICO", label: "Crítico" };
}

/** Base vazia não tem nota: devolve null em vez de inventar um número. */
export function computeHealth(input: HealthInput): HealthResult | null {
  if (!input.total || input.total <= 0) return null;

  const ativacaoPct = (input.ativos / input.total) * 100;
  const comLimite = input.total - (input.indefinidos ?? 0);
  const alcancePct = comLimite > 0 ? (1 - input.semUso / comLimite) * 100 : 0;
  const usoPct = input.limiteTotal > 0 ? (input.valorUtilizado / input.limiteTotal) * 100 : 0;
  const regularidadePct = (1 - input.bloqueados / input.total) * 100;

  const components: HealthComponent[] = [
    {
      key: "ativacao",
      label: "Ativação",
      peso: HEALTH_WEIGHTS.ativacao,
      valor: round1(ativacaoPct),
      meta: HEALTH_TARGETS.ativacao * 100,
      nota: round1(clamp((ativacaoPct / (HEALTH_TARGETS.ativacao * 100)) * 100)),
    },
    {
      key: "alcance",
      label: "Alcance",
      peso: HEALTH_WEIGHTS.alcance,
      valor: round1(clamp(alcancePct)),
      meta: null,
      nota: round1(clamp(alcancePct)),
    },
    {
      key: "usoLimite",
      label: "Uso do limite",
      peso: HEALTH_WEIGHTS.usoLimite,
      valor: round1(clamp(usoPct)),
      meta: HEALTH_TARGETS.usoLimite * 100,
      nota: round1(clamp((usoPct / (HEALTH_TARGETS.usoLimite * 100)) * 100)),
    },
    {
      key: "regularidade",
      label: "Regularidade",
      peso: HEALTH_WEIGHTS.regularidade,
      valor: round1(clamp(regularidadePct)),
      meta: null,
      nota: round1(clamp(regularidadePct)),
    },
  ];

  const score = Math.round(components.reduce((acc, c) => acc + (c.nota * c.peso) / 100, 0));
  const { band, label } = bandFor(score);
  return { score, band, bandLabel: label, components };
}

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

// ---------------------------------------------------------------------------------------------
// Nota por USO REAL (extrato de compras). Substitui a nota estimada quando há extrato em dia.
//
// A nota estimada mede cadastro e saldo (ativação 100% sempre, "sem uso" pelo saldo do momento,
// que varia com a folha). A nota real mede comportamento, a partir das etapas de uso (etapaUso.ts),
// só com clientes COM limite (quem não tem limite é comércio credenciado e fica fora):
//
//  - Alcance (25): % que já usou (antecipação ou compra) no extrato, meta 60%.
//  - Uso recente (30): % que usou nos últimos 30 dias (recorrente + ocasional), meta 30%.
//  - Recorrência (20): % recorrente (3+ usos em 90 dias e uso nos últimos 30), meta 15%.
//  - Retenção (15): entre quem já usou, % que ainda usou nos últimos 90 dias (sem meta).
//  - Regularidade (10): 100 menos o % de clientes bloqueados.
//
// As metas são palpites iniciais, constantes para ajustar com a realidade do negócio.
// ---------------------------------------------------------------------------------------------

export const HEALTH_REAL_TARGETS = { alcance: 0.6, usoRecente: 0.3, recorrencia: 0.15 };
export const HEALTH_REAL_WEIGHTS = { alcance: 25, usoRecente: 30, recorrencia: 20, retencao: 15, regularidade: 10 };

export interface RealHealthInput {
  /** clientes com limite (denominador de tudo, exceto regularidade) */
  comLimite: number;
  nuncaUsou: number;
  recorrente: number;
  ocasional: number;
  emRisco: number;
  inativo: number;
  bloqueados: number;
  /** total de clientes (denominador da regularidade) */
  total: number;
}

export interface RealHealthComponent {
  key: "alcance" | "usoRecente" | "recorrencia" | "retencao" | "regularidade";
  label: string;
  peso: number;
  nota: number;
  valor: number;
  meta: number | null;
}

export interface RealHealthResult {
  score: number;
  band: HealthBand;
  bandLabel: string;
  components: RealHealthComponent[];
}

export function computeRealHealth(i: RealHealthInput): RealHealthResult | null {
  if (!i.total || i.total <= 0 || i.comLimite <= 0) return null;
  const jaUsou = i.recorrente + i.ocasional + i.emRisco + i.inativo;
  const alcance = (jaUsou / i.comLimite) * 100;
  const recente = ((i.recorrente + i.ocasional) / i.comLimite) * 100;
  const recorrencia = (i.recorrente / i.comLimite) * 100;
  const retencao = jaUsou > 0 ? ((i.recorrente + i.ocasional + i.emRisco) / jaUsou) * 100 : 0;
  const regularidade = (1 - i.bloqueados / i.total) * 100;
  const T = HEALTH_REAL_TARGETS;
  const W = HEALTH_REAL_WEIGHTS;
  const vs = (valor: number, meta: number) => round1(clamp((valor / (meta * 100)) * 100));

  const components: RealHealthComponent[] = [
    { key: "alcance", label: "Alcance (já usaram)", peso: W.alcance, valor: round1(clamp(alcance)), meta: T.alcance * 100, nota: vs(alcance, T.alcance) },
    { key: "usoRecente", label: "Usaram nos últimos 30 dias", peso: W.usoRecente, valor: round1(clamp(recente)), meta: T.usoRecente * 100, nota: vs(recente, T.usoRecente) },
    { key: "recorrencia", label: "Uso recorrente", peso: W.recorrencia, valor: round1(clamp(recorrencia)), meta: T.recorrencia * 100, nota: vs(recorrencia, T.recorrencia) },
    { key: "retencao", label: "Retenção (usaram nos últimos 90 dias)", peso: W.retencao, valor: round1(clamp(retencao)), meta: null, nota: round1(clamp(retencao)) },
    { key: "regularidade", label: "Regularidade", peso: W.regularidade, valor: round1(clamp(regularidade)), meta: null, nota: round1(clamp(regularidade)) },
  ];
  const score = Math.round(components.reduce((acc, c) => acc + (c.nota * c.peso) / 100, 0));
  const { band, label } = bandFor(score);
  return { score, band, bandLabel: label, components };
}

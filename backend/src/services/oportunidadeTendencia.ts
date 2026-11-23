/**
 * Tendência de cada oportunidade da fila: compara o tamanho do público hoje com o de uma foto
 * anterior (DashboardSnapshot.oportunidades). Cálculo puro, testado em oportunidadeTendencia.test.ts.
 *
 * A foto de referência é a mais antiga dentro da janela e anterior a hoje; sem nenhuma, não há
 * tendência (o histórico começa no dia em que o snapshot passou a gravar as contagens e não é
 * reconstruível), e a tela mostra isso em vez de uma seta inventada.
 */

export type Direcao = "subiu" | "caiu" | "estavel";
/** Se a mudança é boa para o negócio. "neutro": crescer o público é só mais volume de oportunidade. */
export type Efeito = "melhora" | "piora" | "neutro";

export interface Tendencia {
  /** Distância em dias entre a foto de referência e hoje. */
  dias: number;
  anterior: number;
  atual: number;
  abs: number;
  pct: number | null;
  direcao: Direcao;
  efeito: Efeito;
  leitura: string;
}

export interface FotoOportunidades {
  day: Date;
  valores: Record<string, number> | null | undefined;
}

export const JANELA_PADRAO_DIAS = 30;
/** Abaixo disto (em % e em clientes) a variação é ruído e conta como estável. */
const ESTAVEL_PCT = 3;
const ESTAVEL_MIN_CLIENTES = 5;

/** Públicos em que crescer é ruim (problema ou oportunidade perdida). Os demais são neutros. */
const CRESCER_E_RUIM = new Set([
  "inativos", "semUso", "uso_0", "uso_1_10", "uso_11_20", "semLimite", "semCidade", "validadePassada",
]);

/** Leituras próprias onde o genérico seria pobre. */
const LEITURA_PROPRIA: Record<string, { subiu?: string; caiu?: string }> = {
  uso_71_99: { subiu: "Mais clientes perto do limite: bom momento para oferta de aumento." },
  uso_100: { subiu: "Mais clientes esgotando o limite: maior potencial de valor." },
  novos30d: { caiu: "Entram menos clientes novos que no período anterior." },
  inativos: { subiu: "A base inativa cresce: reativar é a maior alavanca.", caiu: "A reativação está funcionando: a base inativa encolhe." },
  semUso: { subiu: "Entram clientes sem ativação.", caiu: "A ativação está funcionando: menos clientes sem uso." },
};

const DAY_MS = 86_400_000;
const fmtPct = (n: number) => `${Math.round(Math.abs(n))}%`;

export function tendenciaDe(
  key: string,
  atual: number,
  historico: FotoOportunidades[],
  hoje: Date,
  janelaDias = JANELA_PADRAO_DIAS
): Tendencia | null {
  const limite = hoje.getTime() - janelaDias * DAY_MS;
  const candidatas = historico
    .filter((h) => h.day.getTime() < hoje.getTime() && h.day.getTime() >= limite && typeof h.valores?.[key] === "number")
    .sort((a, b) => a.day.getTime() - b.day.getTime());
  const ref = candidatas[0];
  if (!ref) return null;

  const anterior = ref.valores![key];
  const dias = Math.max(1, Math.round((hoje.getTime() - ref.day.getTime()) / DAY_MS));
  const abs = atual - anterior;
  const pct = anterior > 0 ? (abs / anterior) * 100 : null;
  const pequeno = Math.abs(abs) < ESTAVEL_MIN_CLIENTES || (pct !== null && Math.abs(pct) < ESTAVEL_PCT);
  const direcao: Direcao = pequeno ? "estavel" : abs > 0 ? "subiu" : "caiu";

  const ruimCrescer = CRESCER_E_RUIM.has(key);
  const neutro = !ruimCrescer;
  const efeito: Efeito = direcao === "estavel" || neutro ? "neutro" : direcao === "subiu" ? "piora" : "melhora";

  const base = LEITURA_PROPRIA[key];
  let leitura: string;
  if (direcao === "estavel") leitura = `Estável nos últimos ${dias} dias.`;
  else {
    const verbo = direcao === "subiu" ? "Cresceu" : "Caiu";
    const quanto = pct !== null ? `${fmtPct(pct)}` : `${Math.abs(abs)} clientes`;
    const proprio = direcao === "subiu" ? base?.subiu : base?.caiu;
    leitura = `${verbo} ${quanto} em ${dias} dias.${proprio ? ` ${proprio}` : ""}`;
  }
  return { dias, anterior, atual, abs, pct: pct === null ? null : Math.round(pct * 10) / 10, direcao, efeito, leitura };
}

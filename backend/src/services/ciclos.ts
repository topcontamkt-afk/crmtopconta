/**
 * Ciclo de cobrança por cidade: o dia de abertura é quando o limite renova (a fatura é descontada em folha
 * no fechamento, o dia anterior). Cálculo puro, em dias civis de Brasília. Mês curto: abertura no dia 31 vale
 * o último dia do mês (ex.: dia 30 em novembro).
 *
 * O dia de abertura da cidade do cliente é guardado em `Client.diaCicloAbertura` (refeito por
 * `services/cicloRefresh.ts`), assim os filtros de público continuam síncronos e puros.
 */
export interface DiaCivil {
  y: number;
  m: number; // 1-12
  d: number;
}

export interface CicloInfo {
  /** abertura mais recente (hoje, se hoje é o dia de abertura) */
  ultimaAbertura: DiaCivil;
  /** próxima abertura, estritamente depois de hoje */
  proximaAbertura: DiaCivil;
  diasDesdeAbertura: number; // 0 = abriu hoje
  diasParaAbrir: number; // >= 1
  diaDoCiclo: number; // 1 = dia da abertura
}

export const CICLO_FILTRO_MAX = 31;

/** Data civil de hoje em Brasília. */
export function hojeBrasilia(now: Date = new Date()): DiaCivil {
  const [y, m, d] = now.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }).split("-").map(Number);
  return { y, m, d };
}

const diasNoMes = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const utc = (c: DiaCivil) => Date.UTC(c.y, c.m - 1, c.d);
const diff = (a: DiaCivil, b: DiaCivil) => Math.round((utc(a) - utc(b)) / 86400000);

function aberturaNoMes(y: number, m: number, diaAbertura: number): DiaCivil {
  return { y, m, d: Math.min(diaAbertura, diasNoMes(y, m)) };
}

function mesMais(y: number, m: number, delta: number): { y: number; m: number } {
  const idx = y * 12 + (m - 1) + delta;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}

export function validDiaAbertura(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 31;
}

export function cicloInfo(diaAbertura: number, hoje: DiaCivil = hojeBrasilia()): CicloInfo {
  const esteMes = aberturaNoMes(hoje.y, hoje.m, diaAbertura);
  let ultima: DiaCivil;
  let proxima: DiaCivil;
  if (diff(hoje, esteMes) >= 0) {
    ultima = esteMes;
    const n = mesMais(hoje.y, hoje.m, 1);
    proxima = aberturaNoMes(n.y, n.m, diaAbertura);
  } else {
    const p = mesMais(hoje.y, hoje.m, -1);
    ultima = aberturaNoMes(p.y, p.m, diaAbertura);
    proxima = esteMes;
  }
  const diasDesdeAbertura = diff(hoje, ultima);
  return { ultimaAbertura: ultima, proximaAbertura: proxima, diasDesdeAbertura, diasParaAbrir: diff(proxima, hoje), diaDoCiclo: diasDesdeAbertura + 1 };
}

/** Dia de fechamento: o dia anterior à abertura (quando a abertura é dia 1, o último dia do mês anterior = 0). */
export function diaFechamentoPadrao(diaAbertura: number): number {
  return diaAbertura === 1 ? 31 : diaAbertura - 1;
}

export interface FaixaDias {
  min?: number;
  max?: number;
}

/**
 * Quais dias de abertura (1-31) deixam o cliente dentro da faixa HOJE. `abriuHa` olha para trás
 * (0 = abriu hoje); `abreEm` olha para frente (1 = abre amanhã). Alimenta o filtro `diaCicloAbertura in [...]`.
 */
export function diasAberturaNaFaixa(faixa: FaixaDias, sentido: "abriuHa" | "abreEm", hoje: DiaCivil = hojeBrasilia()): number[] {
  const out: number[] = [];
  const min = faixa.min ?? 0;
  const max = faixa.max ?? CICLO_FILTRO_MAX;
  for (let d = 1; d <= 31; d++) {
    const info = cicloInfo(d, hoje);
    const v = sentido === "abriuHa" ? info.diasDesdeAbertura : info.diasParaAbrir;
    if (v >= min && v <= max) out.push(d);
  }
  return out;
}

export function formatDiaCivil(c: DiaCivil): string {
  return `${String(c.d).padStart(2, "0")}/${String(c.m).padStart(2, "0")}/${c.y}`;
}

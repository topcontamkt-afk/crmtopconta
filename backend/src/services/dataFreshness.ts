/**
 * Frescor do extrato de compras. As etapas de uso (etapaUso.ts) e a medição de campanhas só valem
 * até a data da última transação importada: se ninguém sobe a planilha "Todas as Compras", todo
 * mundo "envelhece" e vira inativo/em risco sem ter deixado de usar. Por isso o dashboard avisa e
 * a automação por etapa de uso não dispara com dado velho.
 */
export const MAX_DIAS_EXTRATO_DEFASADO = 3;

export type FrescorStatus = "OK" | "DESATUALIZADO" | "SEM_DADOS";

export interface Frescor {
  status: FrescorStatus;
  ultimaTransacao: Date | null;
  diasDefasagem: number | null;
  limiteDias: number;
}

export function avaliarFrescor(ultimaTransacao: Date | null | undefined, now = new Date(), limiteDias = MAX_DIAS_EXTRATO_DEFASADO): Frescor {
  if (!ultimaTransacao) return { status: "SEM_DADOS", ultimaTransacao: null, diasDefasagem: null, limiteDias };
  const dias = Math.floor((now.getTime() - ultimaTransacao.getTime()) / 86400000);
  return { status: dias > limiteDias ? "DESATUALIZADO" : "OK", ultimaTransacao, diasDefasagem: Math.max(0, dias), limiteDias };
}

export function mensagemFrescor(f: Frescor): string | null {
  if (f.status === "OK") return null;
  if (f.status === "SEM_DADOS") return "Nenhum extrato de compras importado: as etapas de uso não são confiáveis.";
  return `O extrato de compras está parado há ${f.diasDefasagem} dias (última transação em ${f.ultimaTransacao!.toLocaleDateString("pt-BR")}). Suba a planilha "Todas as Compras" para atualizar recorrência e dias sem uso.`;
}

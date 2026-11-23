/**
 * Frescor das fontes de dados: há quantos dias cada insumo foi atualizado e se isso preocupa. Puro
 * (testado em fontesFrescor.test.ts). Fontes sem limite (último disparo, última mensagem recebida)
 * são só informativas: não ter enviado campanha não é um problema de dado.
 */

export type StatusFonte = "ok" | "atencao" | "desatualizado" | "sem_dados" | "info";

export interface FonteEntrada {
  key: string;
  label: string;
  descricao: string;
  ultima: Date | null;
  /** Passou disto (em dias) = atenção. null = sem esse nível. */
  atencaoDias: number | null;
  /** Passou disto (em dias) = desatualizado. null = sem esse nível. */
  desatualizadoDias: number | null;
  /** Para onde ir resolver (rota da tela), quando faz sentido. */
  acao?: { label: string; destino: string };
}

export interface FonteFrescor {
  key: string;
  label: string;
  descricao: string;
  ultima: string | null;
  dias: number | null;
  status: StatusFonte;
  acao: { label: string; destino: string } | null;
}

const DIA_MS = 86_400_000;

export function avaliarFonte(f: FonteEntrada, agora: Date = new Date()): FonteFrescor {
  const dias = f.ultima ? Math.max(0, Math.floor((agora.getTime() - f.ultima.getTime()) / DIA_MS)) : null;
  const semLimites = f.atencaoDias === null && f.desatualizadoDias === null;
  let status: StatusFonte;
  if (dias === null) status = semLimites ? "info" : "sem_dados";
  else if (semLimites) status = "info";
  else if (f.desatualizadoDias !== null && dias > f.desatualizadoDias) status = "desatualizado";
  else if (f.atencaoDias !== null && dias > f.atencaoDias) status = "atencao";
  else status = "ok";
  const precisaAcao = status === "desatualizado" || status === "atencao" || status === "sem_dados";
  return {
    key: f.key,
    label: f.label,
    descricao: f.descricao,
    ultima: f.ultima ? f.ultima.toISOString() : null,
    dias,
    status,
    acao: precisaAcao && f.acao ? f.acao : null,
  };
}

export function avaliarFontes(entradas: FonteEntrada[], agora: Date = new Date()): FonteFrescor[] {
  return entradas.map((e) => avaliarFonte(e, agora));
}

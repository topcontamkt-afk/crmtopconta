/**
 * Funil da campanha: Pessoas → Enviadas → Entregues → Visualizaram → Clicaram (→ Usaram o limite).
 * Puro (sem banco). O status do evento só avança (ENVIADO → ENTREGUE → LIDO → RESPONDIDO), então cada etapa é a
 * soma dos status dela e dos seguintes. Um clique no link só acontece se a mensagem chegou e foi aberta, então quem
 * clicou conta como entregue e visualizou mesmo quando a Meta não devolveu o recibo de entrega/leitura (confirmação
 * de leitura desligada pelo cliente): sem isso o funil mostraria mais cliques do que visualizações.
 */

export interface FunilEtapa {
  chave: "publico" | "enviadas" | "entregues" | "visualizaram" | "clicaram" | "usaram";
  rotulo: string;
  valor: number;
  /** % da etapa anterior (null quando a anterior é zero; "usaram" não é subconjunto de quem clicou, então fica sem) */
  pctDoAnterior: number | null;
  /** % das mensagens enviadas (null quando nada foi enviado) */
  pctDasEnviadas: number | null;
}

export interface Funil {
  publico: number;
  naFila: number;
  enviadas: number;
  entregues: number;
  visualizaram: number;
  clicaram: number;
  responderam: number;
  falhas: number;
  bloqueadas: number;
  controle: number;
  /** clientes que usaram o limite depois do envio (medido só entre os ligados à base); null = não calculado aqui */
  usaram: number | null;
  etapas: FunilEtapa[];
}

const ENVIADOS = ["ENVIADO", "ENTREGUE", "LIDO", "RESPONDIDO"];

export interface FunilEntrada {
  /** contagem de eventos por status */
  porStatus: Record<string, number>;
  /** contagem, por status, dos eventos que tiveram clique no link */
  cliquesPorStatus: Record<string, number>;
  usaram?: number | null;
  /** usado quando a campanha ainda não tem eventos (rascunho) */
  audienceCount?: number | null;
}

const n = (o: Record<string, number>, ...chaves: string[]) => chaves.reduce((a, k) => a + (o[k] ?? 0), 0);
const pct = (parte: number, todo: number) => (todo > 0 ? Number(((parte / todo) * 100).toFixed(1)) : null);

export function montarFunil(e: FunilEntrada): Funil {
  const s = e.porStatus;
  const c = e.cliquesPorStatus;
  const total = Object.entries(s).filter(([k]) => k !== "CONTROLE").reduce((a, [, v]) => a + v, 0);
  const publico = total > 0 ? total : e.audienceCount ?? 0;
  const enviadas = n(s, ...ENVIADOS);
  const clicaram = n(c, ...ENVIADOS);
  const entregues = n(s, "ENTREGUE", "LIDO", "RESPONDIDO") + n(c, "ENVIADO");
  const visualizaram = n(s, "LIDO", "RESPONDIDO") + n(c, "ENVIADO", "ENTREGUE");
  const usaram = e.usaram ?? null;

  const base: { chave: FunilEtapa["chave"]; rotulo: string; valor: number }[] = [
    { chave: "publico", rotulo: "Pessoas na campanha", valor: publico },
    { chave: "enviadas", rotulo: "Mensagens enviadas", valor: enviadas },
    { chave: "entregues", rotulo: "Entregues", valor: entregues },
    { chave: "visualizaram", rotulo: "Visualizaram", valor: visualizaram },
    { chave: "clicaram", rotulo: "Clicaram no link", valor: clicaram },
  ];
  if (usaram !== null) base.push({ chave: "usaram", rotulo: "Usaram o limite", valor: usaram });
  const etapas: FunilEtapa[] = base.map((et, i) => ({ ...et, pctDoAnterior: i === 0 || et.chave === "usaram" ? null : pct(et.valor, base[i - 1].valor), pctDasEnviadas: et.chave === "publico" ? null : pct(et.valor, enviadas) }));

  return {
    publico,
    naFila: n(s, "FILA"),
    enviadas,
    entregues,
    visualizaram,
    clicaram,
    responderam: n(s, "RESPONDIDO"),
    falhas: n(s, "FALHA"),
    bloqueadas: n(s, "BLOQUEADO"),
    controle: n(s, "CONTROLE"),
    usaram,
    etapas,
  };
}

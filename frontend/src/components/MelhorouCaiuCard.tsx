import { Link } from "react-router-dom";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";

export interface InsightVariacao {
  key: string;
  titulo: string;
  atual: number;
  anterior: number;
  abs: number;
  unidade: "pp" | "pts";
  leitura: string;
  acao: { label: string; destino: string } | null;
  prioridade: number;
  confianca: "alta" | "media" | "baixa";
}

export interface MelhorouCaiu {
  melhorou: InsightVariacao[];
  caiu: InsightVariacao[];
  estaveis: number;
  indisponivel: "AMOSTRA_PEQUENA" | null;
  baseline: { day: string; dias: number; pedidoDias: number } | null;
}

const CONFIANCA: Record<InsightVariacao["confianca"], string> = {
  alta: "Confiança alta",
  media: "Confiança média",
  baixa: "Confiança baixa: pouco histórico",
};

const fmt = (n: number) => n.toFixed(1).replace(".", ",");

function Linha({ item, bom }: { item: InsightVariacao; bom: boolean }) {
  const sinal = item.abs > 0 ? "+" : "−";
  const unidade = item.unidade === "pp" ? "p.p." : "pts";
  return (
    <div className="pd-opp">
      <div className="pd-opp-text">
        <strong>{item.titulo}</strong>
        <span>{item.leitura}</span>
        <span className="pd-hint">{CONFIANCA[item.confianca]}</span>
      </div>
      <span className={`pd-delta ${bom ? "up" : "down"}`} title={`${fmt(item.anterior)} → ${fmt(item.atual)}`}>
        {item.abs > 0 ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
        {sinal}
        {fmt(Math.abs(item.abs))} {unidade}
      </span>
      {item.acao && (
        <Link to={item.acao.destino} className="btn secondary" style={{ textDecoration: "none" }}>
          {item.acao.label}
        </Link>
      )}
    </div>
  );
}

/**
 * O que melhorou e o que caiu contra a foto mais antiga da janela. Só existe para a base inteira
 * e com histórico anterior a hoje; fora disso a tela explica por que não há comparação.
 */
export default function MelhorouCaiuCard({ data, temFiltro }: { data: MelhorouCaiu | null; temFiltro: boolean }) {
  if (!data) {
    return (
      <div className="card pd-card">
        <h3>O que melhorou e o que caiu</h3>
        <p className="pd-card-sub">
          {temFiltro
            ? "Com filtro de cidade ou convênio não há comparação: o histórico é da base inteira."
            : "O histórico começou hoje. A comparação aparece a partir do segundo dia."}
        </p>
      </div>
    );
  }
  if (data.indisponivel === "AMOSTRA_PEQUENA") {
    return (
      <div className="card pd-card">
        <h3>O que melhorou e o que caiu</h3>
        <p className="pd-card-sub">Base pequena demais para comparar com segurança.</p>
      </div>
    );
  }
  const vazio = data.melhorou.length === 0 && data.caiu.length === 0;
  return (
    <div className="pd-row">
      <div className="card pd-card pd-grow-1">
        <h3 style={{ color: "var(--success)" }}>O que melhorou</h3>
        <p className="pd-card-sub">
          Contra {data.baseline ? `${data.baseline.dias} dia${data.baseline.dias === 1 ? "" : "s"} atrás` : "o período anterior"}.
          {vazio && " Nenhuma mudança relevante no período."}
        </p>
        <div className="pd-opps">
          {data.melhorou.map((i) => (
            <Linha key={i.key} item={i} bom />
          ))}
          {data.melhorou.length === 0 && !vazio && <span className="pd-card-sub">Nada melhorou de forma relevante.</span>}
        </div>
      </div>
      <div className="card pd-card pd-grow-1">
        <h3 style={{ color: "var(--danger)" }}>O que caiu</h3>
        <p className="pd-card-sub">
          Com a ação sugerida quando houver. {data.estaveis > 0 && `${data.estaveis} indicador(es) estável(is).`}
        </p>
        <div className="pd-opps">
          {data.caiu.map((i) => (
            <Linha key={i.key} item={i} bom={false} />
          ))}
          {data.caiu.length === 0 && <span className="pd-card-sub">Nada piorou de forma relevante.</span>}
        </div>
      </div>
    </div>
  );
}

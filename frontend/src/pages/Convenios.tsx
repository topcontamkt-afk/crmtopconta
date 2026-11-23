import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { api } from "../api/client";

type Situacao = "destaque" | "estavel" | "observar" | "atencao" | "poucos_dados";
type StatusFonte = "ok" | "atencao" | "desatualizado" | "sem_dados" | "info";

interface Convenio {
  chave: string;
  convenio: string;
  clientes: number;
  inativos: number;
  taxaUso: number | null;
  variacaoPp: number | null;
  situacao: Situacao;
  motivo: string;
  clientesEmJogo: number;
  lucroAtual: number;
  lucroVariacaoPct: number | null;
  potencial10pct: number | null;
}
interface Resp {
  disponivel: boolean;
  ultimoDiaExtrato: string | null;
  extratoEmDia: boolean;
  diasDefasagem: number | null;
  semConvenio: { n: number; pct: number };
  convenios: Convenio[];
  emDestaque: Convenio | null;
  precisaAtencao: Convenio | null;
  mediana: number | null;
}
interface Fonte {
  key: string;
  label: string;
  descricao: string;
  ultima: string | null;
  dias: number | null;
  status: StatusFonte;
  acao: { label: string; destino: string } | null;
}

const intFmt = new Intl.NumberFormat("pt-BR");
const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const p1 = (n: number) => n.toFixed(1).replace(".", ",");
const dia = (iso: string) => iso.split("-").reverse().join("/");

const SITUACAO: Record<Situacao, { label: string; cor: string }> = {
  destaque: { label: "Destaque", cor: "var(--success)" },
  estavel: { label: "Estável", cor: "var(--text-muted)" },
  observar: { label: "Observar", cor: "var(--warning)" },
  atencao: { label: "Atenção", cor: "var(--danger)" },
  poucos_dados: { label: "Poucos dados", cor: "var(--text-muted)" },
};
const STATUS_FONTE: Record<StatusFonte, { label: string; cor: string }> = {
  ok: { label: "Em dia", cor: "var(--success)" },
  atencao: { label: "Atenção", cor: "var(--warning)" },
  desatualizado: { label: "Desatualizado", cor: "var(--danger)" },
  sem_dados: { label: "Sem dados", cor: "var(--danger)" },
  info: { label: "Informativo", cor: "var(--text-muted)" },
};

const quando = (f: Fonte) => (f.dias === null ? "nunca" : f.dias === 0 ? "hoje" : `há ${f.dias} dia${f.dias === 1 ? "" : "s"}`);

function Pill({ pp }: { pp: number | null }) {
  if (pp === null) return <span className="pd-delta flat">—</span>;
  const classe = Math.abs(pp) < 1 ? "flat" : pp > 0 ? "up" : "down";
  const Icone = Math.abs(pp) < 1 ? Minus : pp > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`pd-delta ${classe}`}>
      <Icone size={12} /> {pp > 0 ? "+" : pp < 0 ? "−" : ""}
      {p1(Math.abs(pp))} p.p.
    </span>
  );
}

/** Convênios (empresa conveniada) e o frescor das fontes de dados: GET /api/negocio/convenios e /fontes. */
export default function Convenios() {
  const [data, setData] = useState<Resp | null>(null);
  const [fontes, setFontes] = useState<Fonte[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    api<Resp>("/negocio/convenios").then(setData).catch((e) => setErro(e.message));
    api<{ fontes: Fonte[] }>("/negocio/fontes").then((r) => setFontes(r.fontes)).catch(() => setFontes(null));
  }, []);

  const Caixa = ({ c, tipo }: { c: Convenio | null; tipo: "ok" | "ruim" }) => {
    const cor = tipo === "ok" ? "var(--success)" : "var(--danger)";
    return (
      <div style={{ flex: "1 1 320px", minWidth: 0, padding: 14, borderRadius: 12, border: `1px solid ${cor}`, background: tipo === "ok" ? "var(--success-soft)" : "var(--danger-soft)" }}>
        <div className="pd-label" style={{ color: cor, marginBottom: 4 }}>{tipo === "ok" ? "Em destaque" : "Precisa de atenção"}</div>
        {c ? (
          <>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{c.convenio}</div>
            <div className="pd-card-sub" style={{ margin: "4px 0 0" }}>{c.motivo}</div>
            {tipo === "ruim" && c.potencial10pct !== null && c.potencial10pct > 0 && (
              <div className="pd-hint">Reativar 10% dos inativos renderia cerca de {brl.format(c.potencial10pct)} por mês (estimativa).</div>
            )}
          </>
        ) : (
          <div className="pd-card-sub" style={{ margin: 0 }}>{tipo === "ok" ? "Nenhum convênio com alta relevante." : "Nenhum convênio com queda ou nível preocupante."}</div>
        )}
      </div>
    );
  };

  return (
    <div className="pd">
      <div className="pd-head">
        <div>
          <h2 style={{ margin: 0 }}>Convênios</h2>
          <p className="pd-sub">Desempenho por empresa conveniada: base, uso, inatividade e lucro das antecipações.</p>
        </div>
      </div>
      {erro && <div className="error-text">{erro}</div>}

      <div className="card pd-card">
        <h3>Frescor das fontes de dados</h3>
        <p className="pd-card-sub">Quão atualizado está cada insumo. Insights que dependem de uma fonte velha ficam marcados.</p>
        {!fontes ? (
          <div className="pd-skel" style={{ height: 100 }} />
        ) : (
          <div className="pd-row">
            {fontes.map((f) => (
              <div key={f.key} style={{ flex: "1 1 220px", minWidth: 0, padding: 14, borderRadius: 12, background: "var(--surface-alt)", border: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 6 }}>
                <strong style={{ fontSize: 14 }}>{f.label}</strong>
                <span style={{ fontSize: 22, fontWeight: 700 }}>{quando(f)}</span>
                <span className="pd-hint">{f.descricao}</span>
                <span className="badge" style={{ width: "fit-content", color: STATUS_FONTE[f.status].cor, borderColor: STATUS_FONTE[f.status].cor }}>{STATUS_FONTE[f.status].label}</span>
                {f.acao && <Link to={f.acao.destino} className="btn secondary" style={{ textDecoration: "none", width: "fit-content" }}>{f.acao.label}</Link>}
              </div>
            ))}
          </div>
        )}
      </div>

      {!data && !erro && <div className="pd-skel" style={{ height: 240 }} />}
      {data && (
        <>
          {data.semConvenio.pct >= 1 && (
            <p className="pd-note" style={{ color: "var(--warning)" }}>
              {p1(data.semConvenio.pct)}% dos clientes ({intFmt.format(data.semConvenio.n)}) estão sem empresa conveniada e ficam fora deste ranking.
            </p>
          )}
          {!data.disponivel && (
            <p className="pd-note">Importe o extrato de compras para comparar uso e lucro entre os convênios.</p>
          )}
          {data.disponivel && !data.extratoEmDia && (
            <p className="pd-note" style={{ color: "var(--warning)" }}>
              O extrato está parado há {data.diasDefasagem} dias: uso e lucro valem para os 30 dias até {dia(data.ultimoDiaExtrato!)}, contra os 30 anteriores.
            </p>
          )}

          {data.disponivel && (
            <div className="pd-row">
              <Caixa c={data.emDestaque} tipo="ok" />
              <Caixa c={data.precisaAtencao} tipo="ruim" />
            </div>
          )}

          <div className="card pd-card">
            <h3>Ranking de convênios</h3>
            <p className="pd-card-sub">
              Taxa de uso: clientes com limite que usaram o cartão nos 30 dias.{data.mediana !== null && ` Mediana: ${p1(data.mediana)}%.`} Lucro: só juros das antecipações. Potencial: lucro mensal se 10% dos inativos rendessem como quem usou (estimativa).
            </p>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", minWidth: 820 }}>
                <thead>
                  <tr>
                    <th>Convênio</th><th>Clientes</th><th>Taxa de uso</th><th>Variação</th><th>Inativos</th><th>Lucro (30 dias)</th><th>Potencial</th><th>Situação</th>
                  </tr>
                </thead>
                <tbody>
                  {data.convenios.map((c) => (
                    <tr key={c.chave}>
                      <td><Link to={`/clients?empresaConveniada=${encodeURIComponent(c.convenio)}`}>{c.convenio}</Link></td>
                      <td>{intFmt.format(c.clientes)}</td>
                      <td>{c.taxaUso === null ? "—" : `${p1(c.taxaUso)}%`}</td>
                      <td><Pill pp={c.variacaoPp} /></td>
                      <td>{intFmt.format(c.inativos)}</td>
                      <td>
                        {brl.format(c.lucroAtual)}
                        {c.lucroVariacaoPct !== null && <span className="pd-hint" style={{ display: "inline", marginLeft: 6 }}>{c.lucroVariacaoPct > 0 ? "+" : ""}{p1(c.lucroVariacaoPct)}%</span>}
                      </td>
                      <td>{c.potencial10pct === null ? "—" : brl.format(c.potencial10pct)}</td>
                      <td>
                        <span className="badge" style={{ color: SITUACAO[c.situacao].cor, borderColor: SITUACAO[c.situacao].cor }} title={c.motivo}>{SITUACAO[c.situacao].label}</span>
                      </td>
                    </tr>
                  ))}
                  {data.convenios.length === 0 && (
                    <tr><td colSpan={8} style={{ color: "var(--text-muted)" }}>Nenhum convênio cadastrado na base.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

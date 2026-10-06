import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Megaphone } from "lucide-react";
import { api } from "../api/client";

interface Banda {
  key: string;
  range: string;
  label: string;
  titulo: string;
  acao: string;
  mensagem: string;
  cor: string;
  n: number;
}

interface Item {
  key: string;
  grupo: string;
  titulo: string;
  desc: string;
  impacto: "Alto" | "Médio" | "Baixo";
  status: "campanha" | "dados" | "historico" | "zero";
  n: number | null;
  destino?: string;
  destinoLabel?: string;
  motivo?: string;
}

interface Oportunidades {
  totalClientes: number;
  comLimite: number;
  faixas: Banda[];
  itens: Item[];
}

const intFmt = new Intl.NumberFormat("pt-BR");
const IMPACTO_COR: Record<string, string> = { Alto: "#e15b5b", "Médio": "#e0a233", Baixo: "#9aa4b8" };
const BLUE = "#4f7cff";
const AMBER = "#e0a233";
const GREY = "#6f7b96";

/** A faixa 0% é a mesma oportunidade "semUso" (cartão com limite que nunca foi usado). */
const tipoDaFaixa = (key: string) => (key === "uso_0" ? "semUso" : key);

/**
 * Fila de oportunidades: faixas de uso do limite (cortes 50/70/80%) + públicos de ativação, comércio
 * e relacionamento prontos para campanha, itens de qualidade de dados e os que dependem de histórico.
 * Tudo vem de GET /api/dashboard/oportunidades (dados reais); "Criar campanha" abre o assistente com
 * o público e a mensagem sugerida já preenchidos.
 */
export default function OpportunityQueue({ cidade, convenio }: { cidade: string; convenio: string }) {
  const navigate = useNavigate();
  const [data, setData] = useState<Oportunidades | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [banda, setBanda] = useState("uso_100");
  const [grupo, setGrupo] = useState("todas");
  const [criando, setCriando] = useState<string | null>(null);

  const load = useCallback(() => {
    const qs = new URLSearchParams();
    if (cidade) qs.set("cidade", cidade);
    if (convenio) qs.set("empresaConveniada", convenio);
    api<Oportunidades>(`/dashboard/oportunidades?${qs}`)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e.message));
  }, [cidade, convenio]);

  useEffect(load, [load]);

  async function criarCampanha(tipo: string, titulo: string) {
    setCriando(tipo);
    setError(null);
    try {
      const qs = new URLSearchParams({ tipo });
      if (cidade) qs.set("cidade", cidade);
      if (convenio) qs.set("empresaConveniada", convenio);
      const r = await api<{ total: number; clientIds: string[]; mensagem: string | null }>(`/dashboard/audiencia?${qs}`);
      if (r.total === 0) {
        setError("Nenhum cliente neste público para criar a campanha.");
        return;
      }
      navigate("/campaigns/new", {
        state: { presetClientIds: r.clientIds, presetLabel: titulo, presetMessage: r.mensagem ?? undefined },
      });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setCriando(null);
    }
  }

  if (!data) {
    return (
      <div className="card pd-card" style={{ flex: "1 1 100%" }}>
        <h3>Fila de oportunidades</h3>
        {error ? <div className="error-text">{error}</div> : <div className="pd-skel" style={{ height: 200 }} />}
      </div>
    );
  }

  const faixasComUso = data.faixas.filter((b) => b.n > 0);
  const atual = data.faixas.find((b) => b.key === banda) ?? data.faixas[data.faixas.length - 1];
  const grupos = ["todas", ...Array.from(new Set(data.itens.map((i) => i.grupo)))];
  const itens = data.itens.filter((i) => grupo === "todas" || i.grupo === grupo);

  return (
    <div className="card pd-card" style={{ flex: "1 1 100%" }}>
      <h3>Fila de oportunidades</h3>
      <p className="pd-card-sub">Do dado à ação: cada item abre o assistente de campanha com o público e uma mensagem sugerida.</p>
      {error && <div className="error-text" style={{ marginBottom: 10 }}>{error}</div>}

      <div className="pd-label">Faixas de uso do limite · {intFmt.format(data.comLimite)} clientes com limite cadastrado</div>
      <div className="pd-band-bar" role="img" aria-label="Distribuição dos clientes com limite por faixa de uso">
        {faixasComUso.map((b) => (
          <div key={b.key} style={{ width: `${(b.n / Math.max(data.comLimite, 1)) * 100}%`, background: b.cor }} />
        ))}
      </div>
      <div className="pd-bands">
        {data.faixas.map((b) => (
          <button key={b.key} type="button" aria-pressed={banda === b.key} className={`pd-band ${banda === b.key ? "on" : ""}`} style={{ borderTopColor: b.cor, ...(banda === b.key ? { background: `${b.cor}1f`, borderColor: b.cor } : {}) }} onClick={() => setBanda(b.key)}>
            <span className="pd-band-range">{b.range}</span>
            <strong>{intFmt.format(b.n)}</strong>
            <span className="pd-band-label">{b.label}</span>
          </button>
        ))}
      </div>
      <div className="pd-band-detail">
        <div style={{ flex: "1 1 360px", minWidth: 0 }}>
          <strong style={{ fontSize: 15 }}>
            {atual.titulo} · {intFmt.format(atual.n)} {atual.n === 1 ? "cliente" : "clientes"}
          </strong>
          <p className="pd-card-sub" style={{ margin: "6px 0 4px" }}>{atual.acao}</p>
          <p className="pd-hint" style={{ fontStyle: "italic", margin: 0 }}>{atual.mensagem}</p>
        </div>
        <button className="btn" disabled={atual.n === 0 || criando !== null} onClick={() => criarCampanha(tipoDaFaixa(atual.key), atual.titulo)}>
          <Megaphone size={14} /> {atual.n === 0 ? "Nenhum cliente nesta faixa" : criando === tipoDaFaixa(atual.key) ? "Carregando..." : `Criar campanha (${intFmt.format(atual.n)})`}
        </button>
      </div>

      <div className="pd-card-head" style={{ marginTop: 18, marginBottom: 10 }}>
        <div className="pd-label" style={{ margin: 0 }}>Todas as oportunidades</div>
        <div className="pd-chips">
          {grupos.map((g) => (
            <button key={g} type="button" aria-pressed={grupo === g} className={`pd-chip ${grupo === g ? "on" : ""}`} onClick={() => setGrupo(g)}>
              {g === "todas" ? "Todas" : g} <strong>{g === "todas" ? data.itens.length : data.itens.filter((i) => i.grupo === g).length}</strong>
            </button>
          ))}
        </div>
      </div>

      <div className="pd-opps">
        {itens.map((o) => {
          const cor = o.status === "campanha" ? BLUE : o.status === "dados" ? AMBER : GREY;
          const tag =
            o.status === "dados" ? { t: "falta dado", c: AMBER } : o.status === "historico" ? { t: "precisa de histórico", c: GREY } : o.status === "zero" ? { t: "sem público agora", c: GREY } : { t: `impacto ${o.impacto.toLowerCase()}`, c: IMPACTO_COR[o.impacto] };
          return (
            <div key={o.key} className="pd-opp">
              <span className="pd-opp-n" style={{ color: cor, background: `${cor}22` }}>{o.n === null ? "—" : intFmt.format(o.n)}</span>
              <div className="pd-opp-text">
                <span style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                  <strong>{o.titulo}</strong>
                  <span className="pd-tag" style={{ color: GREY, background: "transparent", border: "1px solid var(--border)" }}>{o.grupo}</span>
                  <span className="pd-tag" style={{ color: tag.c, background: `${tag.c}1f` }}>{tag.t}</span>
                </span>
                <span>{o.status === "historico" ? `${o.desc} ${o.motivo ?? ""}` : o.desc}</span>
              </div>
              {o.status === "campanha" ? (
                <button className="btn" disabled={criando !== null} onClick={() => criarCampanha(o.key, o.titulo)}>
                  <Megaphone size={14} /> {criando === o.key ? "Carregando..." : "Criar campanha"}
                </button>
              ) : o.status === "dados" && o.destino ? (
                <Link to={o.destino} className="btn secondary" style={{ textDecoration: "none" }}>
                  {o.destinoLabel ?? "Resolver"}
                </Link>
              ) : (
                <button className="btn secondary" disabled>
                  {o.status === "historico" ? "Em breve" : "Sem público"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

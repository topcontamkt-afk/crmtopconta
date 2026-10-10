import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "../api/client";
import { FAIXA_OPTIONS } from "../utils/faixas";
import { ETAPAS, ETAPA_COR, ETAPA_LABEL, fmtBRL, fmtInt, fmtPct, PERFIL_COR, PERFIL_FAIXA, PERFIS } from "../utils/perfisRenda";

interface Detalhe {
  perfil: string;
  label: string;
  total: number;
  noTeto: number;
  comSaldo: number;
  autorizados: number;
  limiteMedio: number;
  limiteTotal: number;
  valorUtilizado: number;
  saldoDisponivel: number;
  faixas: Record<string, number>;
  etapas: Record<string, number>;
  cidades: { cidade: string; count: number }[];
  convenios: { convenio: string; count: number }[];
}

const GRID = "#2a3346";
const MUTED = "#9aa4b8";

function Tip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-label">{p.label}</div>
      <div className="chart-tooltip-value">{fmtInt(payload[0].value)} clientes</div>
      {p.pct && <div className="chart-tooltip-sub">{p.pct} do perfil</div>}
    </div>
  );
}

/** Página de um perfil de renda (PF1–PF4): números, uso do limite, etapa de uso, cidades e convênios. */
export default function PerfisRenda() {
  const { perfil = "PF1" } = useParams();
  const navigate = useNavigate();
  const [d, setD] = useState<Detalhe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    setD(null);
    api<Detalhe>(`/dashboard/perfis-renda/${perfil}`)
      .then((r) => {
        setD(r);
        setError(null);
      })
      .catch((e) => setError(e.message));
  }, [perfil]);

  async function criarSegmentos() {
    setMsg(null);
    const r = await api<{ criados: number }>("/segments/presets/perfis-renda", { method: "POST" });
    setMsg(`Segmentos de perfil de renda prontos (${r.criados} novos). Veja em Segmentos.`);
  }

  const cor = PERFIL_COR[perfil] ?? "#4f7cff";
  const faixas = d ? FAIXA_OPTIONS.map((f) => ({ label: f.label, count: d.faixas[f.value] ?? 0, pct: fmtPct(d.faixas[f.value] ?? 0, d.total), key: f.value })) : [];
  const etapas = d ? ETAPAS.map((e) => ({ label: ETAPA_LABEL[e], count: d.etapas[e] ?? 0, pct: fmtPct(d.etapas[e] ?? 0, d.total), key: e })) : [];
  const usoPct = d && d.limiteTotal > 0 ? (d.valorUtilizado / d.limiteTotal) * 100 : 0;

  return (
    <div>
      <div className="pd-card-head">
        <div>
          <h2 style={{ margin: 0 }}>Perfis de renda</h2>
          <p className="pd-card-sub" style={{ margin: 0 }}>Salário estimado = limite ÷ 0,40. <Link to="/">← Voltar ao dashboard</Link></p>
        </div>
        <div style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
          {PERFIS.map((p) => (
            <button key={p} type="button" className={p === perfil ? "btn" : "btn secondary"} onClick={() => navigate(`/perfis-renda/${p}`)} style={p === perfil ? { background: PERFIL_COR[p] } : undefined}>
              {p}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="error-text">{error}</div>}
      {!d && !error && <div className="card pd-card">Carregando…</div>}

      {d && (
        <>
          <h3 style={{ margin: "8px 0 12px", color: cor }}>
            {d.perfil} · {PERFIL_FAIXA[d.perfil]}
          </h3>

          <div className="pd-kpis">
            {[
              ["Clientes", fmtInt(d.total), d.noTeto > 0 ? `${fmtInt(d.noTeto)} no teto de R$ 2.000` : "no perfil"],
              ["Limite médio", fmtBRL(d.limiteMedio), `Salário estimado ${fmtBRL(d.limiteMedio / 0.4)}`],
              ["Limite utilizado", `${usoPct.toFixed(1).replace(".", ",")}%`, `${fmtBRL(d.valorUtilizado)} de ${fmtBRL(d.limiteTotal)}`],
              ["Saldo disponível", fmtBRL(d.saldoDisponivel), `${fmtInt(d.comSaldo)} clientes com saldo (≥ R$ 10)`],
              ["Podem receber campanha", fmtInt(d.autorizados), `${fmtPct(d.autorizados, d.total)} do perfil (sem opt-out)`],
            ].map(([label, value, sub]) => (
              <div key={label} className="card" style={{ borderTop: `3px solid ${cor}` }}>
                <div className="kpi-label">{label}</div>
                <div className="kpi-value">{value}</div>
                <div className="pd-hint">{sub}</div>
              </div>
            ))}
          </div>

          <div className="pd-row" style={{ marginTop: 16 }}>
            <div className="card pd-card pd-grow-1">
              <h3>Uso do limite</h3>
              <p className="pd-card-sub">Clientes do perfil por faixa de utilização.</p>
              <ResponsiveContainer width="100%" height={faixas.length * 34 + 20}>
                <BarChart data={faixas} layout="vertical" margin={{ top: 4, right: 20, left: 8, bottom: 4 }} barCategoryGap={10}>
                  <CartesianGrid stroke={GRID} horizontal={false} />
                  <XAxis type="number" tick={{ fill: MUTED, fontSize: 12 }} axisLine={{ stroke: GRID }} tickLine={false} allowDecimals={false} />
                  <YAxis type="category" dataKey="label" tick={{ fill: MUTED, fontSize: 12 }} axisLine={false} tickLine={false} width={130} />
                  <Tooltip content={<Tip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={20} animationDuration={600}>
                    {faixas.map((f) => (
                      <Cell key={f.key} fill={f.key === "SEM_USO" ? "#e0a233" : f.key === "USO_100" ? "#e15b5b" : cor} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="card pd-card pd-grow-1">
              <h3>Etapa de uso</h3>
              <p className="pd-card-sub">Pelo extrato de compras (antecipação e compra à vista).</p>
              <ResponsiveContainer width="100%" height={etapas.length * 34 + 20}>
                <BarChart data={etapas} layout="vertical" margin={{ top: 4, right: 20, left: 8, bottom: 4 }} barCategoryGap={10}>
                  <CartesianGrid stroke={GRID} horizontal={false} />
                  <XAxis type="number" tick={{ fill: MUTED, fontSize: 12 }} axisLine={{ stroke: GRID }} tickLine={false} allowDecimals={false} />
                  <YAxis type="category" dataKey="label" tick={{ fill: MUTED, fontSize: 12 }} axisLine={false} tickLine={false} width={130} />
                  <Tooltip content={<Tip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={20} animationDuration={600}>
                    {etapas.map((e) => (
                      <Cell key={e.key} fill={ETAPA_COR[e.key]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              {d.etapas["NUNCA_USOU"] === d.total && d.total > 0 && (
                <p className="pd-hint" style={{ color: "#e0a233" }}>Sem extrato importado, todos aparecem como "nunca usou".</p>
              )}
            </div>
          </div>

          <div className="pd-row" style={{ marginTop: 16 }}>
            <div className="card pd-card pd-grow-1">
              <h3>Principais cidades</h3>
              {d.cidades.length === 0 && <p className="pd-card-sub">Sem cidade preenchida.</p>}
              {d.cidades.map((c) => (
                <Link key={c.cidade} to={`/clients?cidade=${encodeURIComponent(c.cidade)}`} className="opportunity-city-row">
                  <span>{c.cidade}</span>
                  <span>{fmtInt(c.count)} · {fmtPct(c.count, d.total)}</span>
                </Link>
              ))}
            </div>
            <div className="card pd-card pd-grow-1">
              <h3>Secretarias e convênios</h3>
              {d.convenios.length === 0 && <p className="pd-card-sub">Sem convênio preenchido.</p>}
              {d.convenios.map((c) => (
                <Link key={c.convenio} to={`/clients?empresaConveniada=${encodeURIComponent(c.convenio)}`} className="opportunity-city-row">
                  <span>{c.convenio}</span>
                  <span>{fmtInt(c.count)} · {fmtPct(c.count, d.total)}</span>
                </Link>
              ))}
            </div>
          </div>

          <div className="card pd-card" style={{ marginTop: 16 }}>
            <h3>Ações</h3>
            <p className="pd-card-sub">Os segmentos prontos de perfil e de etapa podem ser usados no assistente de campanha e nas automações.</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn" onClick={criarSegmentos}>Criar segmentos de perfil de renda</button>
              <Link to="/segments" className="btn secondary" style={{ textDecoration: "none" }}>Ir para Segmentos</Link>
              <Link to="/campaigns/new" className="btn secondary" style={{ textDecoration: "none" }}>Nova campanha</Link>
            </div>
            {msg && <p className="pd-hint" style={{ marginTop: 8 }}>{msg}</p>}
          </div>
        </>
      )}
    </div>
  );
}

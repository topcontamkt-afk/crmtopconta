import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "../api/client";
import { FAIXA_OPTIONS } from "../utils/faixas";
import { ETAPAS, ETAPA_COR, ETAPA_LABEL, fmtBRL, fmtInt, fmtPct, PERFIL_COR, PERFIL_FAIXA, PERFIS } from "../utils/perfisRenda";

interface Detalhe {
  perfil: string;
  filtros: { cidade: string | null; de: string | null; ate: string | null };
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
  cidadesDisponiveis: { cidade: string; count: number }[];
  uso: {
    periodo: { de: string | null; ate: string | null } | null;
    clientes: number;
    transacoes: number;
    valorMovimentado: number;
    lucroJuros: number;
    serie: { dia: string; usos: number; clientes: number }[];
  };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const diasAtras = (n: number) => iso(new Date(Date.now() - n * 86400000));
const dataBR = (s: string) => s.split("-").reverse().join("/");

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
  const [params, setParams] = useSearchParams();
  const cidade = params.get("cidade") ?? "";
  const de = params.get("de") ?? "";
  const ate = params.get("ate") ?? "";
  const [cidades, setCidades] = useState<{ cidade: string; count: number }[]>([]);

  function setFiltro(chave: "cidade" | "de" | "ate", valor: string) {
    const next = new URLSearchParams(params);
    if (valor) next.set(chave, valor);
    else next.delete(chave);
    setParams(next, { replace: true });
  }
  function periodoRapido(dias: number | null) {
    const next = new URLSearchParams(params);
    if (dias === null) {
      next.delete("de");
      next.delete("ate");
    } else {
      next.set("de", diasAtras(dias));
      next.set("ate", iso(new Date()));
    }
    setParams(next, { replace: true });
  }
  const ordemDatas = !!(de && ate && de > ate);

  useEffect(() => {
    if (ordemDatas) return;
    const qs = new URLSearchParams();
    if (cidade) qs.set("cidade", cidade);
    if (de) qs.set("de", de);
    if (ate) qs.set("ate", ate);
    let atual = true;
    api<Detalhe>(`/dashboard/perfis-renda/${perfil}?${qs}`)
      .then((r) => {
        if (!atual) return;
        setD(r);
        if (!cidade) setCidades(r.cidadesDisponiveis);
        setError(null);
      })
      .catch((e) => atual && setError(e.message));
    return () => {
      atual = false;
    };
  }, [perfil, cidade, de, ate, ordemDatas]);

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
            <button key={p} type="button" className={p === perfil ? "btn" : "btn secondary"} onClick={() => navigate(`/perfis-renda/${p}${params.toString() ? `?${params}` : ""}`)} style={p === perfil ? { background: PERFIL_COR[p] } : undefined}>
              {p}
            </button>
          ))}
        </div>
      </div>

      <div className="card pd-card" style={{ margin: "12px 0", display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
        <div>
          <label style={{ fontSize: 12 }}>Cidade</label>
          <select value={cidade} onChange={(e) => setFiltro("cidade", e.target.value)}>
            <option value="">Todas as cidades</option>
            {cidades.map((c) => (
              <option key={c.cidade} value={c.cidade}>{c.cidade} ({fmtInt(c.count)})</option>
            ))}
            {cidade && !cidades.some((c) => c.cidade === cidade) && <option value={cidade}>{cidade}</option>}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 12 }}>Uso de</label>
          <input type="date" value={de} max={ate || undefined} onChange={(e) => setFiltro("de", e.target.value)} />
        </div>
        <div>
          <label style={{ fontSize: 12 }}>até</label>
          <input type="date" value={ate} min={de || undefined} onChange={(e) => setFiltro("ate", e.target.value)} />
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {[7, 30, 90].map((n) => (
            <button key={n} type="button" className="btn secondary" style={{ padding: "5px 10px", fontSize: 12 }} onClick={() => periodoRapido(n)}>
              Últimos {n} dias
            </button>
          ))}
          {(cidade || de || ate) && (
            <button type="button" className="btn secondary" style={{ padding: "5px 10px", fontSize: 12 }} onClick={() => setParams({}, { replace: true })}>
              Limpar filtros
            </button>
          )}
        </div>
        <span className="pd-hint" style={{ flexBasis: "100%" }}>
          A cidade recorta todos os números da página. As datas valem para o <strong>uso no período</strong> (extrato de compras): quem usou o cartão entre as duas datas.
        </span>
        {ordemDatas && <span className="error-text" style={{ flexBasis: "100%" }}>A data inicial é depois da final.</span>}
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

          <div className="card pd-card" style={{ marginTop: 16 }}>
            <h3>Uso no período</h3>
            <p className="pd-card-sub">
              {d.uso.periodo
                ? `De ${d.uso.periodo.de ? dataBR(d.uso.periodo.de) : "o início"} até ${d.uso.periodo.ate ? dataBR(d.uso.periodo.ate) : "hoje"}`
                : "Todo o extrato importado"}
              {d.filtros.cidade ? ` · ${d.filtros.cidade}` : ""} · antecipação e compra à vista
            </p>
            <div className="pd-kpis" style={{ marginBottom: 12 }}>
              {[
                ["Clientes que usaram", fmtInt(d.uso.clientes), `${fmtPct(d.uso.clientes, d.total)} do perfil`],
                ["Transações", fmtInt(d.uso.transacoes), d.uso.clientes > 0 ? `${(d.uso.transacoes / d.uso.clientes).toFixed(1).replace(".", ",")} por cliente` : "—"],
                ["Valor movimentado", fmtBRL(d.uso.valorMovimentado), "antecipação + compras"],
                ["Lucro (juros)", fmtBRL(d.uso.lucroJuros), "só antecipações; compra à vista não tem lucro conhecido"],
              ].map(([label, value, sub]) => (
                <div key={label} className="card" style={{ borderTop: `3px solid ${cor}` }}>
                  <div className="kpi-label">{label}</div>
                  <div className="kpi-value">{value}</div>
                  <div className="pd-hint">{sub}</div>
                </div>
              ))}
            </div>
            {d.uso.serie.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={d.uso.serie.map((p) => ({ ...p, label: dataBR(p.dia) }))} margin={{ top: 4, right: 20, left: 0, bottom: 4 }}>
                  <CartesianGrid stroke={GRID} vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: MUTED, fontSize: 11 }} axisLine={{ stroke: GRID }} tickLine={false} minTickGap={24} />
                  <YAxis tick={{ fill: MUTED, fontSize: 12 }} axisLine={false} tickLine={false} allowDecimals={false} width={36} />
                  <Tooltip
                    cursor={{ stroke: GRID }}
                    content={({ active, payload }: any) =>
                      active && payload?.length ? (
                        <div className="chart-tooltip">
                          <div className="chart-tooltip-label">{payload[0].payload.label}</div>
                          <div className="chart-tooltip-value">{fmtInt(payload[0].payload.clientes)} clientes</div>
                          <div className="chart-tooltip-sub">{fmtInt(payload[0].payload.usos)} transações</div>
                        </div>
                      ) : null
                    }
                  />
                  <Area type="monotone" dataKey="clientes" stroke={cor} fill={cor} fillOpacity={0.18} strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <p className="pd-hint" style={{ color: "#e0a233" }}>
                Nenhuma transação de uso no recorte. Se o extrato de compras ainda não foi importado, suba a planilha "Todas as Compras" em Importações.
              </p>
            )}
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

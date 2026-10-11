import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "../api/client";
import { ETAPAS, ETAPA_COR, ETAPA_LABEL, fmtInt, fmtPct, PERFIL_COR, PERFIL_FAIXA } from "../utils/perfisRenda";

interface Perfil {
  perfil: string;
  label: string;
  total: number;
  noTeto: number;
  faixas: Record<string, number>;
  etapas: Record<string, number>;
}
interface Resp {
  perfis: Perfil[];
  semLimite: number;
  extrato: { primeira: string | null; ultima: string | null };
}

const GRID = "#2a3346";
const MUTED = "#9aa4b8";

const SERIE_LIMITE = [
  { key: "sem", label: "Sem uso", cor: "#9aa4b8", pick: (p: Perfil) => p.faixas["SEM_USO"] ?? 0 },
  { key: "baixo", label: "1 a 30%", cor: "#4f7cff", pick: (p: Perfil) => (p.faixas["USO_1_10"] ?? 0) + (p.faixas["USO_11_20"] ?? 0) + (p.faixas["USO_21_30"] ?? 0) },
  { key: "medio", label: "31 a 70%", cor: "#35c17a", pick: (p: Perfil) => (p.faixas["USO_31_50"] ?? 0) + (p.faixas["USO_51_70"] ?? 0) },
  { key: "alto", label: "71 a 99%", cor: "#e0a233", pick: (p: Perfil) => p.faixas["USO_71_99"] ?? 0 },
  { key: "cheio", label: "100% esgotado", cor: "#e15b5b", pick: (p: Perfil) => p.faixas["USO_100"] ?? 0 },
];
const SERIE_ETAPA = ETAPAS.map((e) => ({ key: e, label: ETAPA_LABEL[e], cor: ETAPA_COR[e], pick: (p: Perfil) => p.etapas[e] ?? 0 }));

type Visao = "limite" | "etapa";

/** Perfis de renda PF1–PF4 no padrão dos demais cards do dashboard; clicar abre a página do perfil. */
export default function PerfisRendaCard({ cidade, convenio }: { cidade: string; convenio: string }) {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visao, setVisao] = useState<Visao>("limite");
  const navigate = useNavigate();

  useEffect(() => {
    const qs = new URLSearchParams();
    if (cidade) qs.set("cidade", cidade);
    if (convenio) qs.set("empresaConveniada", convenio);
    api<Resp>(`/dashboard/perfis-renda?${qs}`)
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e) => setError(e.message));
  }, [cidade, convenio]);

  if (error) return <div className="card pd-card pd-grow-1 error-text">Perfis de renda: {error}</div>;
  if (!data) return null;

  const total = data.perfis.reduce((a, p) => a + p.total, 0);
  const series = visao === "limite" ? SERIE_LIMITE : SERIE_ETAPA;
  const barras = data.perfis.map((p) => ({ label: p.perfil, count: p.total, perfil: p.perfil }));
  const abrir = (perfil: string) => navigate(`/perfis-renda/${perfil}`);

  return (
    <div className="card pd-card pd-grow-1">
      <div className="pd-card-head">
        <div>
          <h3>Perfis de renda</h3>
          <p className="pd-card-sub" style={{ margin: 0 }}>
            Salário estimado = limite ÷ 0,40. {fmtInt(data.semLimite)} clientes sem limite (comércio credenciado) ficam fora. Clique em um perfil para ver os detalhes.
          </p>
        </div>
        <div className="pd-tabs" style={{ display: "inline-flex", gap: 6 }}>
          {([["limite", "Uso do limite"], ["etapa", "Etapa de uso"]] as const).map(([v, l]) => (
            <button key={v} type="button" className={visao === v ? "btn" : "btn secondary"} style={{ padding: "5px 12px", fontSize: 12 }} onClick={() => setVisao(v)}>
              {l}
            </button>
          ))}
        </div>
      </div>

      {visao === "etapa" && !data.extrato.ultima && (
        <p className="pd-hint" style={{ color: "#e0a233" }}>
          Nenhum extrato de compras importado ainda: todos aparecem como "nunca usou" até o primeiro envio.
        </p>
      )}

      <div className="pd-row" style={{ alignItems: "flex-start" }}>
        <div className="pd-grow-1">
          <div className="pd-hint" style={{ marginBottom: 4 }}>Clientes por perfil</div>
          <ResponsiveContainer width="100%" height={190}>
            <BarChart data={barras} layout="vertical" margin={{ top: 4, right: 20, left: 8, bottom: 4 }} barCategoryGap={10}>
              <CartesianGrid stroke={GRID} horizontal={false} />
              <XAxis type="number" tick={{ fill: MUTED, fontSize: 12 }} axisLine={{ stroke: GRID }} tickLine={false} allowDecimals={false} />
              <YAxis type="category" dataKey="label" tick={{ fill: MUTED, fontSize: 12 }} axisLine={false} tickLine={false} width={48} />
              <Tooltip
                cursor={{ fill: "rgba(255,255,255,0.04)" }}
                content={({ active, payload }: any) =>
                  active && payload?.length ? (
                    <div className="chart-tooltip">
                      <div className="chart-tooltip-label">{payload[0].payload.label} · {PERFIL_FAIXA[payload[0].payload.label]}</div>
                      <div className="chart-tooltip-value">{fmtInt(payload[0].value)} clientes</div>
                      <div className="chart-tooltip-sub">{fmtPct(payload[0].value, total)} da base</div>
                    </div>
                  ) : null
                }
              />
              <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={22} animationDuration={600} cursor="pointer" onClick={(d: any) => abrir(d.perfil)}>
                {barras.map((b) => (
                  <Cell key={b.perfil} fill={PERFIL_COR[b.perfil]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="pd-grow-13">
          <div className="pd-hint" style={{ marginBottom: 8 }}>
            {visao === "limite" ? "Como cada perfil usa o limite" : "Em que etapa de uso cada perfil está"}
          </div>
          {data.perfis.map((p) => (
            <Link key={p.perfil} to={`/perfis-renda/${p.perfil}`} className="opportunity-city-row" style={{ display: "block", marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                <span>
                  <strong style={{ color: PERFIL_COR[p.perfil] }}>{p.perfil}</strong> · {PERFIL_FAIXA[p.perfil]}
                  {p.noTeto > 0 && <span className="pd-hint"> · {fmtInt(p.noTeto)} no teto de R$ 2.000</span>}
                </span>
                <span>{fmtInt(p.total)} · {fmtPct(p.total, total)}</span>
              </div>
              <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", background: GRID }}>
                {series.map((s) => (
                  <div key={s.key} title={`${s.label}: ${fmtInt(s.pick(p))}`} style={{ width: p.total > 0 ? `${(s.pick(p) / p.total) * 100}%` : 0, background: s.cor }} />
                ))}
              </div>
            </Link>
          ))}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", fontSize: 12, color: MUTED }}>
            {series.map((s) => (
              <span key={s.key} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: s.cor }} />
                {s.label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

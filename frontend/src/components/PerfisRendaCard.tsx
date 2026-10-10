import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "../api/client";

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

const fmt = (n: number) => n.toLocaleString("pt-BR");
const pct = (n: number, t: number) => (t > 0 ? `${((n / t) * 100).toFixed(1).replace(".", ",")}%` : "0%");

const PERFIL_COR: Record<string, string> = { PF1: "#4f7cff", PF2: "#ff6907", PF3: "#22c55e", PF4: "#a855f7" };
const PERFIL_FAIXA: Record<string, string> = {
  PF1: "até R$ 4.000",
  PF2: "R$ 4.001 a 8.000",
  PF3: "R$ 8.001 a 12.000",
  PF4: "R$ 12.001 a 100.000",
};

type Visao = "limite" | "etapa";

/** Séries de cada visão: agrupa as faixas de uso do limite ou usa as etapas de uso real. */
const SERIES: Record<Visao, { key: string; label: string; cor: string; pick: (p: Perfil) => number }[]> = {
  limite: [
    { key: "sem", label: "Sem uso", cor: "#64748b", pick: (p) => p.faixas["SEM_USO"] ?? 0 },
    { key: "baixo", label: "1 a 30%", cor: "#38bdf8", pick: (p) => (p.faixas["USO_1_10"] ?? 0) + (p.faixas["USO_11_20"] ?? 0) + (p.faixas["USO_21_30"] ?? 0) },
    { key: "medio", label: "31 a 70%", cor: "#22c55e", pick: (p) => (p.faixas["USO_31_50"] ?? 0) + (p.faixas["USO_51_70"] ?? 0) },
    { key: "alto", label: "71 a 99%", cor: "#f59e0b", pick: (p) => p.faixas["USO_71_99"] ?? 0 },
    { key: "cheio", label: "100% esgotado", cor: "#ef4444", pick: (p) => p.faixas["USO_100"] ?? 0 },
  ],
  etapa: [
    { key: "NUNCA_USOU", label: "Nunca usou", cor: "#64748b", pick: (p) => p.etapas["NUNCA_USOU"] ?? 0 },
    { key: "RECORRENTE", label: "Recorrente", cor: "#22c55e", pick: (p) => p.etapas["RECORRENTE"] ?? 0 },
    { key: "OCASIONAL", label: "Ocasional", cor: "#38bdf8", pick: (p) => p.etapas["OCASIONAL"] ?? 0 },
    { key: "EM_RISCO", label: "Em risco", cor: "#f59e0b", pick: (p) => p.etapas["EM_RISCO"] ?? 0 },
    { key: "INATIVO", label: "Inativo", cor: "#ef4444", pick: (p) => p.etapas["INATIVO"] ?? 0 },
  ],
};

function Tip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#0f1624", border: "1px solid #2a3550", borderRadius: 8, padding: "8px 10px", fontSize: 12 }}>
      {label && <div style={{ marginBottom: 4, fontWeight: 600 }}>{label}</div>}
      {payload.map((p: any) => (
        <div key={p.name} style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color || p.payload?.fill }} />
          {p.name}: <strong>{fmt(Number(p.value))}</strong>
        </div>
      ))}
    </div>
  );
}

/** Perfis de renda PF1–PF4 (limite ÷ 0,40): distribuição, uso do limite e etapa de uso, com seleção interativa. */
export default function PerfisRendaCard({ cidade, convenio }: { cidade: string; convenio: string }) {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visao, setVisao] = useState<Visao>("limite");
  const [sel, setSel] = useState<string | null>(null);
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

  const series = SERIES[visao];
  const total = useMemo(() => (data ? data.perfis.reduce((a, p) => a + p.total, 0) : 0), [data]);
  const barras = useMemo(
    () =>
      (data?.perfis ?? []).map((p) => {
        const row: Record<string, number | string> = { perfil: p.perfil };
        for (const s of series) row[s.key] = s.pick(p);
        return row;
      }),
    [data, series]
  );

  if (error) return <div className="card pd-card error-text">Perfis de renda: {error}</div>;
  if (!data) return null;

  const donut = data.perfis.map((p) => ({ name: p.perfil, value: p.total, fill: PERFIL_COR[p.perfil] }));
  const foco = data.perfis.find((p) => p.perfil === sel) ?? null;
  const semExtrato = !data.extrato.ultima;

  return (
    <div className="card pd-card">
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <div>
          <h3 style={{ margin: 0 }}>Perfis de renda</h3>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            Salário estimado = limite ÷ 0,40 · {fmt(data.semLimite)} sem limite (comércio credenciado) ficam fora
          </div>
        </div>
        <div style={{ display: "inline-flex", border: "1px solid #2a3550", borderRadius: 999, overflow: "hidden" }}>
          {([["limite", "Uso do limite"], ["etapa", "Etapa de uso"]] as const).map(([v, l]) => (
            <button
              key={v}
              type="button"
              onClick={() => setVisao(v)}
              style={{
                border: 0, padding: "6px 14px", fontSize: 12, cursor: "pointer", color: "inherit",
                background: visao === v ? "var(--primary)" : "transparent",
              }}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      {visao === "etapa" && semExtrato && (
        <div style={{ fontSize: 12, color: "#f59e0b", marginTop: 8 }}>
          Nenhum extrato de compras importado ainda: todos aparecem como "nunca usou" até o primeiro envio.
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 280px) 1fr", gap: 20, marginTop: 14, alignItems: "center" }} className="perfis-grid">
        <div style={{ position: "relative", height: 220 }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={donut} dataKey="value" nameKey="name" innerRadius={68} outerRadius={96} paddingAngle={2} stroke="none"
                onClick={(d: any) => setSel(sel === d.name ? null : d.name)} cursor="pointer"
              >
                {donut.map((d) => (
                  <Cell key={d.name} fill={d.fill} opacity={sel && sel !== d.name ? 0.3 : 1} />
                ))}
              </Pie>
              <Tooltip content={<Tip />} />
            </PieChart>
          </ResponsiveContainer>
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
            <div style={{ fontSize: 26, fontWeight: 700 }}>{fmt(foco ? foco.total : total)}</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{foco ? `${foco.perfil} · ${pct(foco.total, total)}` : "clientes com limite"}</div>
          </div>
        </div>

        <div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>
            {visao === "limite" ? "Como cada perfil usa o limite" : "Em que etapa de uso cada perfil está"} (% do perfil)
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={barras} layout="vertical" stackOffset="expand" margin={{ left: 0, right: 8 }}>
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="perfil" width={42} tick={{ fill: "#9aa4b8", fontSize: 12 }} axisLine={false} tickLine={false} />
              <Tooltip content={<Tip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
              {series.map((s) => (
                <Bar key={s.key} dataKey={s.key} name={s.label} stackId="a" fill={s.cor} radius={2} />
              ))}
            </BarChart>
          </ResponsiveContainer>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", fontSize: 12 }}>
            {series.map((s) => (
              <span key={s.key} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: s.cor }} />
                {s.label}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10, marginTop: 16 }}>
        {data.perfis.map((p) => {
          const ativo = sel === p.perfil;
          return (
            <button
              key={p.perfil}
              type="button"
              onClick={() => setSel(ativo ? null : p.perfil)}
              style={{
                textAlign: "left", cursor: "pointer", color: "inherit", padding: 12, borderRadius: 10,
                background: ativo ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.02)",
                border: `1px solid ${ativo ? PERFIL_COR[p.perfil] : "#2a3550"}`,
                borderTop: `3px solid ${PERFIL_COR[p.perfil]}`,
              }}
            >
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{p.perfil} · {PERFIL_FAIXA[p.perfil]}</div>
              <div style={{ fontSize: 24, fontWeight: 700 }}>{fmt(p.total)}</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                {pct(p.total, total)} da base{p.noTeto > 0 && ` · ${fmt(p.noTeto)} no teto R$ 2.000`}
              </div>
              <div style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", marginTop: 8, background: "#1c2640" }}>
                {series.map((s) => (
                  <div key={s.key} style={{ width: p.total > 0 ? `${(s.pick(p) / p.total) * 100}%` : 0, background: s.cor }} />
                ))}
              </div>
            </button>
          );
        })}
      </div>

      {foco && (
        <div style={{ marginTop: 14, padding: 12, borderRadius: 10, background: "rgba(255,255,255,0.03)", border: "1px solid #2a3550" }}>
          <strong>{foco.label}</strong>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px", fontSize: 13, margin: "8px 0" }}>
            {series.map((s) => (
              <span key={s.key}>
                <span style={{ color: s.cor }}>●</span> {s.label}: <strong>{fmt(s.pick(foco))}</strong> ({pct(s.pick(foco), foco.total)})
              </span>
            ))}
          </div>
          <button className="btn secondary" onClick={() => navigate("/segments")}>Criar segmentos de {foco.perfil}</button>
        </div>
      )}
      {!foco && (
        <button className="btn secondary" style={{ marginTop: 12 }} onClick={() => navigate("/segments")}>
          Criar segmentos por perfil
        </button>
      )}
      <style>{`@media (max-width: 720px) { .perfis-grid { grid-template-columns: 1fr !important; } }`}</style>
    </div>
  );
}

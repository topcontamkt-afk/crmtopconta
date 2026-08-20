import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../api/client";

interface Summary {
  totalClientes: number;
  novosClientes: number;
  ativos: number;
  inativos: number;
  porFaixa: { faixa: string; label: string; count: number }[];
  ranking_cidades: { cidade: string; count: number }[];
  limiteTotalLiberado: number;
  valorUtilizadoTotal: number;
  saldoDisponivelTotal: number;
  ticketMedio: number;
  percentualClientes100: string;
  clientesSemUso: number;
  ultimaAtualizacao: string | null;
}

interface UsoMensal {
  totalClientes: number;
  taxaMesAtual: number;
  meses: { mes: string; label: string; usados: number; percent: number }[];
}

const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

// Uma única cor de marca por gráfico (magnitude é expressa pelo comprimento/altura da marca,
// não por variação de matiz) — ver skill de dataviz: "sequential = uma cor".
const CHART_COLOR = "#4f7cff";
const CHART_GRID = "#2a3346";
const CHART_MUTED = "#9aa4b8";

export default function Dashboard() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [usoMensal, setUsoMensal] = useState<UsoMensal | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function load() {
      Promise.all([api<Summary>("/dashboard/summary"), api<UsoMensal>("/dashboard/uso-mensal")])
        .then(([s, u]) => {
          setSummary(s);
          setUsoMensal(u);
        })
        .catch((e) => setError(e.message));
    }
    load();
    // Near-real-time (Fase 3): sem WebSocket, mas o dashboard se atualiza sozinho a cada 30s.
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, []);

  if (error) return <div className="error-text">{error}</div>;
  if (!summary || !usoMensal) return <div>Carregando...</div>;

  const mesAtualLabel = usoMensal.meses[usoMensal.meses.length - 1]?.label ?? "";

  return (
    <div>
      <h2>Dashboard</h2>
      <div className="grid-kpi">
        {[
          { label: "Total de clientes", value: summary.totalClientes },
          { label: "Novos (30 dias)", value: summary.novosClientes },
          { label: "Ativos", value: summary.ativos },
          { label: "Inativos", value: summary.inativos },
          { label: "Limite total liberado", value: currency.format(Number(summary.limiteTotalLiberado)) },
          { label: "Valor utilizado", value: currency.format(Number(summary.valorUtilizadoTotal)) },
          { label: "Saldo disponível", value: currency.format(Number(summary.saldoDisponivelTotal)) },
          { label: "Ticket médio", value: currency.format(Number(summary.ticketMedio)) },
          { label: "% clientes no limite", value: `${summary.percentualClientes100}%` },
          { label: "Clientes sem uso", value: summary.clientesSemUso },
        ].map((kpi, i) => (
          <Kpi key={kpi.label} label={kpi.label} value={kpi.value} delay={i * 40} />
        ))}
      </div>

      <div className="card chart-card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
          <h3 style={{ margin: 0 }}>Taxa de uso mensal da base</h3>
          <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
            {mesAtualLabel}: <strong style={{ color: "var(--text)", fontSize: 20 }}>{usoMensal.taxaMesAtual}%</strong> da base usou o limite
          </span>
        </div>
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, marginBottom: 12 }}>
          % de clientes cuja última utilização registrada caiu em cada mês (últimos 12 meses).
        </p>
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={usoMensal.meses} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
            <defs>
              <linearGradient id="usoGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CHART_COLOR} stopOpacity={0.35} />
                <stop offset="100%" stopColor={CHART_COLOR} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={CHART_GRID} vertical={false} />
            <XAxis dataKey="label" tick={{ fill: CHART_MUTED, fontSize: 12 }} axisLine={{ stroke: CHART_GRID }} tickLine={false} />
            <YAxis
              tick={{ fill: CHART_MUTED, fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              width={40}
              unit="%"
            />
            <Tooltip content={<ChartTooltip suffix="% da base" countKey="usados" countLabel="clientes" />} />
            <Area
              type="monotone"
              dataKey="percent"
              stroke={CHART_COLOR}
              strokeWidth={2}
              fill="url(#usoGradient)"
              dot={{ r: 3, fill: CHART_COLOR, strokeWidth: 0 }}
              activeDot={{ r: 5, fill: CHART_COLOR, strokeWidth: 2, stroke: "#0f1420" }}
              animationDuration={900}
              animationEasing="ease-out"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div className="card chart-card">
          <h3>Clientes por faixa de utilização</h3>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart
              data={summary.porFaixa}
              layout="vertical"
              margin={{ top: 4, right: 20, left: 8, bottom: 4 }}
              barCategoryGap={10}
            >
              <CartesianGrid stroke={CHART_GRID} horizontal={false} />
              <XAxis type="number" tick={{ fill: CHART_MUTED, fontSize: 12 }} axisLine={{ stroke: CHART_GRID }} tickLine={false} allowDecimals={false} />
              <YAxis
                type="category"
                dataKey="label"
                tick={{ fill: CHART_MUTED, fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                width={120}
              />
              <Tooltip content={<ChartTooltip countLabel="clientes" />} />
              <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={22} animationDuration={700} animationEasing="ease-out">
                {summary.porFaixa.map((f) => (
                  <Cell key={f.faixa} fill={CHART_COLOR} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card chart-card">
          <h3>Ranking de cidades</h3>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart
              data={summary.ranking_cidades}
              layout="vertical"
              margin={{ top: 4, right: 20, left: 8, bottom: 4 }}
              barCategoryGap={10}
            >
              <CartesianGrid stroke={CHART_GRID} horizontal={false} />
              <XAxis type="number" tick={{ fill: CHART_MUTED, fontSize: 12 }} axisLine={{ stroke: CHART_GRID }} tickLine={false} allowDecimals={false} />
              <YAxis
                type="category"
                dataKey="cidade"
                tick={{ fill: CHART_MUTED, fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                width={120}
              />
              <Tooltip content={<ChartTooltip countLabel="clientes" />} />
              <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={22} animationDuration={700} animationEasing="ease-out">
                {summary.ranking_cidades.map((c) => (
                  <Cell key={c.cidade} fill={CHART_COLOR} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <p style={{ marginTop: 16, color: "var(--text-muted)", fontSize: 13 }}>
        Última atualização: {summary.ultimaAtualizacao ? new Date(summary.ultimaAtualizacao).toLocaleString("pt-BR") : "—"}
      </p>
    </div>
  );
}

function Kpi({ label, value, delay = 0 }: { label: string; value: string | number; delay?: number }) {
  return (
    <div className="card kpi-animate" style={{ animationDelay: `${delay}ms` }}>
      <div className="kpi-value">{value}</div>
      <div className="kpi-label">{label}</div>
    </div>
  );
}

/** Tooltip minimalista compartilhado pelos gráficos, no mesmo tom visual dos cards do app. */
function ChartTooltip({
  active,
  payload,
  label,
  suffix,
  countKey,
  countLabel,
}: {
  active?: boolean;
  payload?: any[];
  label?: string;
  suffix?: string;
  countKey?: string;
  countLabel?: string;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  const value = payload[0].value;
  const sub = countKey && point[countKey] !== undefined ? `${point[countKey]} ${countLabel ?? ""}`.trim() : null;
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-label">{label}</div>
      <div className="chart-tooltip-value">
        {value}
        {suffix ? ` ${suffix}` : countLabel && !countKey ? ` ${countLabel}` : ""}
      </div>
      {sub && <div className="chart-tooltip-sub">{sub}</div>}
    </div>
  );
}

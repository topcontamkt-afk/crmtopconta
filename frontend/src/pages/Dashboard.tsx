import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
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
import { Wallet, TrendingUp, PiggyBank, Users, RefreshCw } from "lucide-react";
import { api } from "../api/client";

interface Summary {
  totalClientes: number;
  novosClientes: number;
  ativos: number;
  inativos: number;
  porFaixa: { faixa: string; label: string; count: number }[];
  ranking_cidades: { cidade: string; count: number; ativos: number; valorUtilizado: number }[];
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

interface Encerramentos {
  totalClientes: number;
  taxaMesAtual: number;
  meses: { mes: string; label: string; encerrados: number; percent: number }[];
  motivos: { motivo: string; count: number }[];
}

const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const percentFmt = (n: number) => `${n.toFixed(1)}%`;

// Uma única cor de marca por gráfico (magnitude é expressa pelo comprimento/altura da marca,
// não por variação de matiz) — ver skill de dataviz: "sequential = uma cor".
const CHART_COLOR = "#4f7cff";
const CHART_DANGER = "#e15b5b";
const CHART_GRID = "#2a3346";
const CHART_MUTED = "#9aa4b8";

// Ordem canônica das faixas de uso (o groupBy do backend não garante ordem determinística).
const FAIXA_ORDER = [
  "NAO_UTILIZOU",
  "BAIXO_USO",
  "USO_INICIAL",
  "USO_INTERMEDIARIO",
  "USO_ALTO",
  "QUASE_COMPLETO",
  "LIMITE_COMPLETO",
  "INDEFINIDO",
];

export default function Dashboard() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [usoMensal, setUsoMensal] = useState<UsoMensal | null>(null);
  const [encerramentos, setEncerramentos] = useState<Encerramentos | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function load() {
    setLoading(true);
    Promise.all([
      api<Summary>("/dashboard/summary"),
      api<UsoMensal>("/dashboard/uso-mensal"),
      api<Encerramentos>("/dashboard/encerramentos"),
    ])
      .then(([s, u, e]) => {
        setSummary(s);
        setUsoMensal(u);
        setEncerramentos(e);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // Near-real-time (Fase 3): sem WebSocket, mas o dashboard se atualiza sozinho a cada 30s.
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, []);

  if (error) return <div className="error-text">{error}</div>;
  if (!summary || !usoMensal || !encerramentos) return <div>Carregando...</div>;

  const mesAtualLabel = usoMensal.meses[usoMensal.meses.length - 1]?.label ?? "";
  const temDadosEncerramento = encerramentos.meses.some((m) => m.encerrados > 0);
  const temDadosUso = usoMensal.meses.some((m) => m.usados > 0);

  const limite = Number(summary.limiteTotalLiberado);
  const utilizado = Number(summary.valorUtilizadoTotal);
  const disponivel = Number(summary.saldoDisponivelTotal);
  const percentUtilizado = limite > 0 ? (utilizado / limite) * 100 : 0;
  const percentDisponivel = limite > 0 ? (disponivel / limite) * 100 : 0;
  const percentAtivos = summary.totalClientes > 0 ? (summary.ativos / summary.totalClientes) * 100 : 0;
  const percentInativos = summary.totalClientes > 0 ? (summary.inativos / summary.totalClientes) * 100 : 0;
  const percentSemUso = summary.totalClientes > 0 ? (summary.clientesSemUso / summary.totalClientes) * 100 : 0;

  const porFaixaOrdenado = [...summary.porFaixa].sort(
    (a, b) => FAIXA_ORDER.indexOf(a.faixa) - FAIXA_ORDER.indexOf(b.faixa)
  );
  const quaseCompleto = summary.porFaixa.find((f) => f.faixa === "QUASE_COMPLETO")?.count || 0;

  // Cidades com pelo menos 5 clientes e a menor taxa de ativação entre as top 10 — oportunidade
  // de foco comercial/comunicação. Calculado no cliente a partir do ranking já trazido.
  const cidadesBaixaAtivacao = summary.ranking_cidades
    .filter((c) => c.count >= 5)
    .map((c) => ({ ...c, taxa: c.count ? (c.ativos / c.count) * 100 : 0 }))
    .sort((a, b) => a.taxa - b.taxa)
    .slice(0, 3);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>Dashboard</h2>
        <button className="btn secondary" onClick={load} disabled={loading} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <RefreshCw size={14} className={loading ? "spin" : undefined} />
          Atualizar
        </button>
      </div>
      <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 0, marginBottom: 20 }}>
        Última atualização: {summary.ultimaAtualizacao ? new Date(summary.ultimaAtualizacao).toLocaleString("pt-BR") : "—"}
      </p>

      <div className="grid-kpi-primary">
        <KpiPrimary
          icon={<Wallet size={17} color="var(--primary)" />}
          iconBg="var(--primary-soft)"
          label="Limite total liberado"
          value={currency.format(limite)}
          trend="Valor total disponibilizado à base"
        />
        <KpiPrimary
          icon={<TrendingUp size={17} color="var(--accent)" />}
          iconBg="var(--accent-soft)"
          label="Valor utilizado"
          value={currency.format(utilizado)}
          trend={<><strong>{percentFmt(percentUtilizado)}</strong> do limite consumido</>}
        />
        <KpiPrimary
          icon={<PiggyBank size={17} color="var(--success)" />}
          iconBg="var(--success-soft)"
          label="Saldo disponível"
          value={currency.format(disponivel)}
          trend={<><strong>{percentFmt(percentDisponivel)}</strong> ainda disponível — oportunidade de ativação</>}
        />
        <KpiPrimary
          icon={<Users size={17} color="var(--success)" />}
          iconBg="var(--success-soft)"
          label="Clientes ativos"
          value={summary.ativos}
          trend={<><strong>{percentFmt(percentAtivos)}</strong> da base total</>}
        />
      </div>

      <div className="grid-kpi-secondary">
        <KpiSecondary label="Total de clientes" value={summary.totalClientes} />
        <KpiSecondary label="Novos (30 dias)" value={summary.novosClientes} />
        <KpiSecondary label="Inativos" value={summary.inativos} sub={`${percentFmt(percentInativos)} da base`} />
        <KpiSecondary label="Sem utilização" value={summary.clientesSemUso} sub={`${percentFmt(percentSemUso)} da base`} />
        <KpiSecondary label="Ticket médio" value={currency.format(Number(summary.ticketMedio))} />
        <KpiSecondary label="% no limite" value={`${summary.percentualClientes100}%`} />
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0, marginBottom: 2 }}>Utilização do limite</h3>
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 0, marginBottom: 12 }}>
          {currency.format(utilizado)} utilizados de {currency.format(limite)} liberados
        </p>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${Math.min(100, percentUtilizado)}%` }} />
        </div>
        <div className="progress-legend">
          <span className="progress-legend-item">
            <span className="progress-legend-dot" style={{ background: "var(--accent)" }} />
            Utilizado: <strong>{currency.format(utilizado)}</strong> ({percentFmt(percentUtilizado)})
          </span>
          <span className="progress-legend-item">
            <span className="progress-legend-dot" style={{ background: "var(--surface-alt)", border: "1px solid var(--border)" }} />
            Disponível: <strong>{currency.format(disponivel)}</strong> ({percentFmt(percentDisponivel)})
          </span>
          <span className="progress-legend-item">
            Ticket médio: <strong>{currency.format(Number(summary.ticketMedio))}</strong>
          </span>
        </div>
      </div>

      <div className="section-title">Oportunidades de ação</div>
      <div className="grid-opportunities" style={{ marginBottom: 20 }}>
        <Link to="/clients?faixaUso=NAO_UTILIZOU" className="opportunity-card">
          <div className="kpi-value">{summary.clientesSemUso}</div>
          <div className="kpi-label">Clientes sem uso</div>
          <p>Nunca utilizaram o cartão — bons candidatos a campanha de ativação.</p>
        </Link>
        <Link to="/clients?statusConta=INATIVO" className="opportunity-card">
          <div className="kpi-value">{summary.inativos}</div>
          <div className="kpi-label">Clientes inativos</div>
          <p>{percentFmt(percentInativos)} da base — reengajamento é a prioridade.</p>
        </Link>
        <Link to="/clients?faixaUso=QUASE_COMPLETO" className="opportunity-card">
          <div className="kpi-value">{quaseCompleto}</div>
          <div className="kpi-label">Quase no limite</div>
          <p>Perto de esgotar o limite — considerar renovação/aumento.</p>
        </Link>
        <div className="opportunity-card" style={{ cursor: "default" }}>
          <div className="kpi-label" style={{ marginBottom: 8 }}>Cidades com baixa ativação</div>
          {cidadesBaixaAtivacao.length === 0 ? (
            <p>Sem dados suficientes por cidade ainda.</p>
          ) : (
            <div className="opportunity-city-list">
              {cidadesBaixaAtivacao.map((c) => (
                <Link key={c.cidade} to={`/clients?cidade=${encodeURIComponent(c.cidade)}&statusConta=INATIVO`} className="opportunity-city-row">
                  <span>{c.cidade} ({c.count})</span>
                  <span>{percentFmt(c.taxa)} ativos</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card chart-card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
          <h3 style={{ margin: 0 }}>Taxa de uso mensal da base</h3>
          {temDadosUso && (
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
              {mesAtualLabel}: <strong style={{ color: "var(--text)", fontSize: 20 }}>{usoMensal.taxaMesAtual}%</strong> da base usou o limite
            </span>
          )}
        </div>
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, marginBottom: 12 }}>
          % de clientes cuja última utilização registrada caiu em cada mês (últimos 12 meses).
        </p>
        {!temDadosUso ? (
          <div className="chart-empty-state">
            <strong>Ainda não há histórico de uso suficiente para exibir a evolução mensal</strong>
            <span>
              Essa taxa depende da data de ativação/última utilização de cada cliente. Reimporte a
              planilha com esse dado atualizado, ou sincronize as transações, para o gráfico passar
              a mostrar tendência.
            </span>
          </div>
        ) : (
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
        )}
      </div>

      <div className="card chart-card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
          <h3 style={{ margin: 0 }}>Taxa de cancelamento mensal</h3>
          {temDadosEncerramento && (
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
              {mesAtualLabel}: <strong style={{ color: "var(--danger)", fontSize: 20 }}>{encerramentos.taxaMesAtual}%</strong> da base encerrou a conta
            </span>
          )}
        </div>
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, marginBottom: 12 }}>
          % de clientes cuja conta foi encerrada em cada mês (últimos 12 meses). Só disponível para
          clientes importados no formato "Cartões e contas" / "SaldoCartao".
        </p>
        {!temDadosEncerramento ? (
          <div className="chart-empty-state">
            <strong>Nenhum encerramento de conta registrado ainda na base</strong>
            <span>Assim que houver cancelamentos importados, essa evolução aparece aqui.</span>
          </div>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={encerramentos.meses} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="encerramentoGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={CHART_DANGER} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={CHART_DANGER} stopOpacity={0} />
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
                <Tooltip content={<ChartTooltip suffix="% da base" countKey="encerrados" countLabel="contas" />} />
                <Area
                  type="monotone"
                  dataKey="percent"
                  stroke={CHART_DANGER}
                  strokeWidth={2}
                  fill="url(#encerramentoGradient)"
                  dot={{ r: 3, fill: CHART_DANGER, strokeWidth: 0 }}
                  activeDot={{ r: 5, fill: CHART_DANGER, strokeWidth: 2, stroke: "#0f1420" }}
                  animationDuration={900}
                  animationEasing="ease-out"
                />
              </AreaChart>
            </ResponsiveContainer>
            {encerramentos.motivos.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Motivos mais comuns: </span>
                {encerramentos.motivos.map((m) => (
                  <span key={m.motivo} className="badge" style={{ marginRight: 6 }}>
                    {m.motivo} ({m.count})
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div className="card chart-card">
          <h3>Clientes por faixa de utilização</h3>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart
              data={porFaixaOrdenado}
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
                {porFaixaOrdenado.map((f) => (
                  <Cell key={f.faixa} fill={CHART_COLOR} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card chart-card">
          <h3>Ranking de cidades</h3>
          {summary.ranking_cidades.length === 0 ? (
            <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Sem dados de cidade na base ainda.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>Cidade</th>
                    <th>Clientes</th>
                    <th>Ativos</th>
                    <th>Taxa</th>
                    <th>Valor utilizado</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.ranking_cidades.map((c) => (
                    <tr key={c.cidade}>
                      <td>
                        <Link to={`/clients?cidade=${encodeURIComponent(c.cidade)}`}>{c.cidade}</Link>
                      </td>
                      <td>{c.count}</td>
                      <td>{c.ativos}</td>
                      <td>{c.count ? percentFmt((c.ativos / c.count) * 100) : "—"}</td>
                      <td>{currency.format(c.valorUtilizado)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function KpiPrimary({
  icon,
  iconBg,
  label,
  value,
  trend,
}: {
  icon: React.ReactNode;
  iconBg: string;
  label: string;
  value: string | number;
  trend: React.ReactNode;
}) {
  return (
    <div className="kpi-card-primary kpi-animate">
      <div className="kpi-icon" style={{ background: iconBg }}>
        {icon}
      </div>
      <div>
        <div className="kpi-value">{value}</div>
        <div className="kpi-label">{label}</div>
      </div>
      <div className="kpi-trend">{trend}</div>
    </div>
  );
}

function KpiSecondary({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="kpi-card-secondary kpi-animate">
      <div className="kpi-value">{value}</div>
      <div className="kpi-label">{label}</div>
      {sub && <div className="kpi-trend" style={{ marginTop: 4 }}>{sub}</div>}
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

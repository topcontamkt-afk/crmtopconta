import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
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
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Cake,
  Lightbulb,
  Megaphone,
  PiggyBank,
  RefreshCw,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import { api } from "../api/client";
import OpportunityQueue from "../components/OpportunityQueue";
import { FAIXA_LABELS, FAIXA_OPTIONS } from "../utils/faixas";

type Delta = { abs: number; pct: number | null } | null;

interface Overview {
  periodo: { dias: number; desde: string };
  filtros: {
    aplicados: { cidade: string | null; empresaConveniada: string | null };
    cidades: { valor: string; count: number }[];
    convenios: { valor: string; count: number }[];
  };
  kpis: {
    totalClientes: number;
    ativos: number;
    inativos: number;
    bloqueados: number;
    semUso: number;
    quaseCompleto: number;
    limiteCompleto: number;
    limiteTotal: number;
    valorUtilizado: number;
    saldoDisponivel: number;
    ticketMedio: number;
    faixas: Record<string, number>;
    novosNoPeriodo: number;
  };
  deltas: Record<"limiteTotal" | "valorUtilizado" | "saldoDisponivel" | "ativos" | "totalClientes" | "inativos" | "semUso" | "score", Delta>;
  baseline: { day: string; dias: number; pedidoDias: number } | null;
  historicoDisponivel: boolean;
  series: {
    day: string;
    ativos: number;
    totalClientes: number;
    limiteTotal: number;
    valorUtilizado: number;
    saldoDisponivel: number;
    usoLimitePct: number;
    ativosPct: number;
    usaramNoDia: number;
    encerradosNoDia: number;
    score: number | null;
  }[];
  saude: {
    score: number;
    band: "SAUDAVEL" | "ATENCAO" | "CRITICO";
    bandLabel: string;
    delta: Delta;
    components: { key: string; label: string; peso: number; nota: number; valor: number; meta: number | null }[];
  } | null;
  funil: { key: string; label: string; count: number }[];
  oportunidades: { inativos: number; semUso: number; quaseCompleto: number; aniversariantes: number };
  rankingCidades: { cidade: string; count: number; ativos: number; valorUtilizado: number }[];
  rankingSecretarias: { empresaConveniada: string; count: number; ativos: number; valorUtilizado: number }[];
  campanhas: {
    temDados: boolean;
    campanhas: number;
    enviadas: number;
    entregues: number;
    respondidas: number;
    convertidas: number;
    taxaEntrega: number | null;
    taxaResposta: number | null;
    taxaConversao: number | null;
    valorConvertido: number;
    custo: number;
  };
  cobertura: { key: string; label: string; preenchidos: number; pct: number; libera: string }[];
  insights: { tipo: "alerta" | "oportunidade" | "positivo" | "info"; texto: string }[];
  ultimaAtualizacao: string | null;
}

interface Perfil {
  faixaEtaria: { faixa: string; count: number }[];
  porSexo: { sexo: string; count: number }[];
  faixaRenda: { faixa: string; count: number }[];
}

type ChartTab = "uso" | "ativos" | "encerramentos" | "saude";

const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const intFmt = new Intl.NumberFormat("pt-BR");
const pct = (n: number) => `${n.toFixed(1).replace(".", ",")}%`;
const dayLabel = (iso: string) => iso.slice(8, 10) + "/" + iso.slice(5, 7);

const COLOR = { primary: "#4f7cff", accent: "#ff6907", success: "#35c17a", warning: "#e0a233", danger: "#e15b5b", purple: "#9b87f5" };
const GRID = "#2a3346";
const MUTED = "#9aa4b8";

const FAIXA_ORDER = [...FAIXA_OPTIONS.map((f) => f.value as string), "INDEFINIDO"];

const CHART_TABS: { key: ChartTab; label: string }[] = [
  { key: "uso", label: "Uso do limite" },
  { key: "ativos", label: "Clientes ativos" },
  { key: "encerramentos", label: "Encerramentos" },
  { key: "saude", label: "Nota de saúde" },
];


const REFRESH_MS = 60_000;

export default function Dashboard() {
  const navigate = useNavigate();
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [cidade, setCidade] = useState("");
  const [convenio, setConvenio] = useState("");
  const [tab, setTab] = useState<ChartTab>("uso");
  const [data, setData] = useState<Overview | null>(null);
  const [perfil, setPerfil] = useState<Perfil | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(() => {
    const id = ++requestId.current;
    setLoading(true);
    const qs = new URLSearchParams({ days: String(days) });
    if (cidade) qs.set("cidade", cidade);
    if (convenio) qs.set("empresaConveniada", convenio);
    Promise.all([api<Overview>(`/dashboard/overview?${qs}`), api<Perfil>("/dashboard/perfil")])
      .then(([o, p]) => {
        if (id !== requestId.current) return; // resposta de um filtro anterior: descarta
        setData(o);
        setPerfil(p);
        setError(null);
      })
      .catch((e) => id === requestId.current && setError(e.message))
      .finally(() => id === requestId.current && setLoading(false));
  }, [days, cidade, convenio]);

  useEffect(() => {
    load();
    // Atualização automática leve: só com a aba visível, para não gastar função serverless à toa.
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, REFRESH_MS);
    return () => clearInterval(interval);
  }, [load]);

  if (error && !data) return <div className="error-text">{error}</div>;
  if (!data) return <DashboardSkeleton />;

  const k = data.kpis;
  const temFiltro = !!(cidade || convenio);
  const utilizadoPct = k.limiteTotal > 0 ? (k.valorUtilizado / k.limiteTotal) * 100 : 0;
  const sparkOf = (pick: (s: Overview["series"][number]) => number) => (data.historicoDisponivel ? data.series.map(pick) : []);

  const faixas = FAIXA_ORDER.filter((f) => (k.faixas[f] ?? 0) > 0).map((f) => ({ faixa: f, label: FAIXA_LABELS[f], count: k.faixas[f] }));
  const cidadesBaixaAtivacao = data.rankingCidades
    .filter((c) => c.count >= 5)
    .map((c) => ({ ...c, taxa: (c.ativos / c.count) * 100 }))
    .sort((a, b) => a.taxa - b.taxa)
    .slice(0, 3);

  return (
    <div className="pd">
      <div className="pd-head">
        <div>
          <h2 style={{ margin: 0 }}>Visão geral da base</h2>
          <p className="pd-sub">
            {intFmt.format(k.totalClientes)} clientes{temFiltro ? " neste recorte" : ""} · última importação:{" "}
            {data.ultimaAtualizacao ? new Date(data.ultimaAtualizacao).toLocaleString("pt-BR") : "—"}
          </p>
        </div>
        <div className="pd-filters">
          <div className="pd-seg" role="group" aria-label="Período">
            {([7, 30, 90] as const).map((d) => (
              <button key={d} type="button" className={days === d ? "on" : ""} aria-pressed={days === d} onClick={() => setDays(d)}>
                {d} dias
              </button>
            ))}
          </div>
          <select className="pd-select" aria-label="Filtrar por cidade" value={cidade} onChange={(e) => setCidade(e.target.value)}>
            <option value="">Todas as cidades</option>
            {data.filtros.cidades.map((c) => (
              <option key={c.valor} value={c.valor}>
                {c.valor} ({c.count})
              </option>
            ))}
          </select>
          <select className="pd-select" aria-label="Filtrar por convênio" value={convenio} onChange={(e) => setConvenio(e.target.value)}>
            <option value="">Todos os convênios</option>
            {data.filtros.convenios.map((c) => (
              <option key={c.valor} value={c.valor}>
                {c.valor} ({c.count})
              </option>
            ))}
          </select>
          <button className="btn secondary pd-refresh" onClick={load} disabled={loading}>
            <RefreshCw size={14} className={loading ? "spin" : undefined} /> Atualizar
          </button>
        </div>
      </div>

      {error && <div className="error-text" style={{ marginBottom: 12 }}>{error}</div>}

      {/* KPIs principais com tendência real (snapshots) */}
      <div className="pd-kpis">
        <Kpi
          icon={<Wallet size={17} />}
          color={COLOR.primary}
          label="Limite total liberado"
          value={currency.format(k.limiteTotal)}
          sub="Disponibilizado à base"
          delta={data.deltas.limiteTotal}
          deltaKind="pct"
          spark={sparkOf((s) => s.limiteTotal)}
        />
        <Kpi
          icon={<TrendingUp size={17} />}
          color={COLOR.accent}
          label="Valor utilizado"
          value={currency.format(k.valorUtilizado)}
          sub={`${pct(utilizadoPct)} do limite consumido`}
          delta={data.deltas.valorUtilizado}
          deltaKind="pct"
          spark={sparkOf((s) => s.valorUtilizado)}
        />
        <Kpi
          icon={<PiggyBank size={17} />}
          color={COLOR.success}
          label="Saldo disponível"
          value={currency.format(k.saldoDisponivel)}
          sub={`${pct(k.limiteTotal > 0 ? (k.saldoDisponivel / k.limiteTotal) * 100 : 0)} ainda disponível`}
          delta={data.deltas.saldoDisponivel}
          deltaKind="pct"
          spark={sparkOf((s) => s.saldoDisponivel)}
        />
        <Kpi
          icon={<Users size={17} />}
          color={COLOR.purple}
          label="Clientes ativos"
          value={intFmt.format(k.ativos)}
          sub={`${pct(k.totalClientes > 0 ? (k.ativos / k.totalClientes) * 100 : 0)} da base`}
          delta={data.deltas.ativos}
          deltaKind="abs"
          spark={sparkOf((s) => s.ativos)}
        />
      </div>
      <p className="pd-note">
        {temFiltro
          ? "Com filtro ativo os números são do recorte; variações e histórico só existem para a base inteira."
          : data.baseline
            ? `Variação contra ${dayLabel(data.baseline.day)} (${data.baseline.dias} dia${data.baseline.dias === 1 ? "" : "s"} atrás${
                data.baseline.dias < data.baseline.pedidoDias ? `, o histórico mais antigo disponível — pedido: ${data.baseline.pedidoDias} dias` : ""
              }).`
            : "Histórico iniciado hoje: as variações aparecem a partir do segundo dia."}
      </p>

      <div className="pd-row">
        <ChartCard data={data} tab={tab} setTab={setTab} temFiltro={temFiltro} />
        <HealthCard saude={data.saude} />
      </div>

      <div className="pd-row">
        <OpportunityQueue cidade={cidade} convenio={convenio} />
      </div>

      <div className="pd-row">
        {cidadesBaixaAtivacao.length > 0 && (
          <div className="card pd-card pd-grow-1">
            <h3>Cidades com menor ativação</h3>
            <p className="pd-card-sub">Cidades com pelo menos 5 clientes e a menor taxa de ativos.</p>
            {cidadesBaixaAtivacao.map((c) => (
              <Link key={c.cidade} to={`/clients?cidade=${encodeURIComponent(c.cidade)}&statusConta=INATIVO`} className="opportunity-city-row">
                <span>
                  {c.cidade} ({c.count})
                </span>
                <span>{pct(c.taxa)} ativos</span>
              </Link>
            ))}
          </div>
        )}

        <div className="card pd-card pd-grow-1">
          <h3>Ativação da base</h3>
          <p className="pd-card-sub">Onde a base perde força.</p>
          {data.funil.map((f) => {
            const base = data.funil[0]?.count || 0;
            const share = base > 0 ? (f.count / base) * 100 : 0;
            return (
              <div key={f.key} className="pd-bar-row">
                <div className="pd-bar-head">
                  <span>{f.label}</span>
                  <span>
                    {intFmt.format(f.count)} · {pct(share)}
                  </span>
                </div>
                <div className="pd-track">
                  <div className="pd-fill" style={{ width: `${Math.max(share, f.count > 0 ? 1.5 : 0)}%`, background: f.key === "ativos" ? COLOR.success : COLOR.primary }} />
                </div>
              </div>
            );
          })}
        </div>

        <div className="card pd-card pd-grow-1">
          <h3>Resultado das campanhas</h3>
          <p className="pd-card-sub">Últimos {data.periodo.dias} dias, sem campanhas de teste.</p>
          {!data.campanhas.temDados ? (
            <div className="pd-empty">
              <strong>Nenhuma campanha enviada no período</strong>
              <span>Quando houver envios, entrega, resposta e conversão aparecem aqui.</span>
              <Link to="/campaigns/new" className="btn" style={{ textDecoration: "none" }}>
                Nova campanha
              </Link>
            </div>
          ) : (
            <>
              <div className="pd-mini-grid">
                <Mini label="Enviadas" value={intFmt.format(data.campanhas.enviadas)} />
                <Mini label="Entregues" value={intFmt.format(data.campanhas.entregues)} sub={data.campanhas.taxaEntrega !== null ? pct(data.campanhas.taxaEntrega) : undefined} />
                <Mini label="Respostas" value={intFmt.format(data.campanhas.respondidas)} sub={data.campanhas.taxaResposta !== null ? pct(data.campanhas.taxaResposta) : undefined} />
                <Mini label="Conversões" value={intFmt.format(data.campanhas.convertidas)} sub={data.campanhas.taxaConversao !== null ? pct(data.campanhas.taxaConversao) : undefined} />
              </div>
              <div className="pd-kv">
                <span>Valor convertido</span>
                <strong>{currency.format(data.campanhas.valorConvertido)}</strong>
              </div>
              <div className="pd-kv">
                <span>Custo de envio</span>
                <strong>{currency.format(data.campanhas.custo)}</strong>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="pd-row">
        <div className="card pd-card pd-grow-1">
          <h3>Insights</h3>
          <p className="pd-card-sub">Gerados automaticamente a partir dos dados acima.</p>
          <div className="pd-insights">
            {data.insights.map((i, idx) => (
              <div key={idx} className={`pd-insight ${i.tipo}`}>
                {i.tipo === "alerta" ? <AlertTriangle size={16} /> : <Lightbulb size={16} />}
                <span>{i.texto}</span>
              </div>
            ))}
            {data.insights.length === 0 && <span className="pd-card-sub">Sem insights no momento.</span>}
          </div>
        </div>

        <div className="card pd-card pd-grow-1">
          <h3>Cobertura dos dados</h3>
          <p className="pd-card-sub">O que está preenchido na base e o que cada campo libera.</p>
          {data.cobertura.map((c) => (
            <div key={c.key} className="pd-bar-row">
              <div className="pd-bar-head">
                <span>{c.label}</span>
                <span>{pct(c.pct)}</span>
              </div>
              <div className="pd-track">
                <div className="pd-fill" style={{ width: `${c.pct}%`, background: c.pct >= 80 ? COLOR.success : c.pct >= 30 ? COLOR.warning : COLOR.danger }} />
              </div>
              {c.pct < 80 && <div className="pd-hint">Libera: {c.libera}</div>}
            </div>
          ))}
          <Link to="/imports" className="btn secondary" style={{ textDecoration: "none", marginTop: 12, display: "inline-block" }}>
            Importar / completar dados
          </Link>
        </div>

        <div className="card pd-card pd-grow-1">
          <h3>Clientes por faixa de utilização</h3>
          <ResponsiveContainer width="100%" height={Math.max(160, faixas.length * 34)}>
            <BarChart data={faixas} layout="vertical" margin={{ top: 4, right: 20, left: 8, bottom: 4 }} barCategoryGap={10}>
              <CartesianGrid stroke={GRID} horizontal={false} />
              <XAxis type="number" tick={{ fill: MUTED, fontSize: 12 }} axisLine={{ stroke: GRID }} tickLine={false} allowDecimals={false} />
              <YAxis type="category" dataKey="label" tick={{ fill: MUTED, fontSize: 12 }} axisLine={false} tickLine={false} width={120} />
              <Tooltip content={<ChartTooltip countLabel="clientes" />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
              <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={20} animationDuration={600}>
                {faixas.map((f) => (
                  <Cell key={f.faixa} fill={f.faixa === "SEM_USO" ? COLOR.warning : COLOR.primary} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="pd-row">
        <RankingCard
          titulo="Ranking de cidades"
          colunaNome="Cidade"
          linhas={data.rankingCidades.map((r) => ({ nome: r.cidade, count: r.count, ativos: r.ativos, valor: r.valorUtilizado, link: `/clients?cidade=${encodeURIComponent(r.cidade)}` }))}
          vazio="Nenhum cliente tem cidade preenchida ainda. Complete a coluna de cidade na planilha para liberar este ranking."
        />
        <RankingCard
          titulo="Ranking de secretarias e convênios"
          colunaNome="Secretaria / convênio"
          linhas={data.rankingSecretarias.map((r) => ({ nome: r.empresaConveniada, count: r.count, ativos: r.ativos, valor: r.valorUtilizado, link: `/clients?empresaConveniada=${encodeURIComponent(r.empresaConveniada)}` }))}
          vazio="Sem dado de convênio ainda. Disponível para clientes importados no formato “Cartões e contas”."
        />
      </div>

      {perfil && (
        <div className="pd-row">
          <div className="card pd-card pd-grow-1">
            <h3>Faixa etária</h3>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={perfil.faixaEtaria} margin={{ top: 4, right: 12, left: -18, bottom: 4 }}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="faixa" tick={{ fill: MUTED, fontSize: 12 }} axisLine={{ stroke: GRID }} tickLine={false} />
                <YAxis tick={{ fill: MUTED, fontSize: 12 }} axisLine={false} tickLine={false} width={36} allowDecimals={false} />
                <Tooltip content={<ChartTooltip countLabel="clientes" />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={34} fill={COLOR.primary} animationDuration={600} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="card pd-card pd-grow-1">
            <h3>Sexo</h3>
            {perfil.porSexo.length === 0 ? (
              <p className="pd-card-sub">Sem dado cadastrado ainda.</p>
            ) : (
              perfil.porSexo.map((s) => {
                const tot = perfil.porSexo.reduce((a, x) => a + x.count, 0);
                const share = tot ? (s.count / tot) * 100 : 0;
                return (
                  <div key={s.sexo} className="pd-bar-row">
                    <div className="pd-bar-head">
                      <span>{s.sexo}</span>
                      <span>
                        {intFmt.format(s.count)} · {pct(share)}
                      </span>
                    </div>
                    <div className="pd-track">
                      <div className="pd-fill" style={{ width: `${share}%`, background: COLOR.primary }} />
                    </div>
                  </div>
                );
              })
            )}
            <div className="pd-kv" style={{ marginTop: 12 }}>
              <span>
                <Cake size={14} style={{ verticalAlign: "-2px" }} /> Aniversariantes do mês
              </span>
              <strong>{intFmt.format(data.oportunidades.aniversariantes)}</strong>
            </div>
          </div>
          {perfil.faixaRenda.some((r) => r.faixa !== "desconhecida") && (
            <div className="card pd-card pd-grow-1">
              <h3>Perfil de renda</h3>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={perfil.faixaRenda} layout="vertical" margin={{ top: 4, right: 20, left: 8, bottom: 4 }} barCategoryGap={8}>
                  <CartesianGrid stroke={GRID} horizontal={false} />
                  <XAxis type="number" tick={{ fill: MUTED, fontSize: 12 }} axisLine={{ stroke: GRID }} tickLine={false} allowDecimals={false} />
                  <YAxis type="category" dataKey="faixa" tick={{ fill: MUTED, fontSize: 11 }} axisLine={false} tickLine={false} width={110} />
                  <Tooltip content={<ChartTooltip countLabel="clientes" />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={18} fill={COLOR.primary} animationDuration={600} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- Blocos ---------- */

function Kpi({
  icon,
  color,
  label,
  value,
  sub,
  delta,
  deltaKind,
  spark,
}: {
  icon: React.ReactNode;
  color: string;
  label: string;
  value: string;
  sub: string;
  delta: Delta;
  deltaKind: "pct" | "abs";
  spark: number[];
}) {
  return (
    <div className="pd-kpi kpi-animate">
      <div className="pd-kpi-top">
        <span className="pd-kpi-icon" style={{ color, background: `${color}22` }}>
          {icon}
        </span>
        <span className="pd-kpi-label">{label}</span>
        <DeltaChip delta={delta} kind={deltaKind} />
      </div>
      <div className="pd-kpi-body">
        <div>
          <div className="pd-kpi-value">{value}</div>
          <div className="pd-kpi-sub">{sub}</div>
        </div>
        <Sparkline values={spark} color={color} />
      </div>
    </div>
  );
}

function DeltaChip({ delta, kind }: { delta: Delta; kind: "pct" | "abs" }) {
  if (!delta || (kind === "pct" && delta.pct === null) || delta.abs === 0) {
    return <span className="pd-delta flat">{delta && delta.abs === 0 ? "estável" : "—"}</span>;
  }
  const up = delta.abs > 0;
  const text = kind === "pct" ? pct(Math.abs(delta.pct as number)) : intFmt.format(Math.abs(delta.abs));
  return (
    <span className={`pd-delta ${up ? "up" : "down"}`}>
      {up ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
      {text}
    </span>
  );
}

/** Mini-gráfico de tendência; sem pelo menos 2 pontos reais não desenha nada (nada inventado). */
function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return <span className="pd-spark-empty">sem histórico</span>;
  const w = 112;
  const h = 40;
  const mn = Math.min(...values);
  const mx = Math.max(...values);
  const rng = mx - mn || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 4 - ((v - mn) / rng) * (h - 10)]);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d={`${line} L${w} ${h} L0 ${h} Z`} fill={color} fillOpacity={0.14} />
      <path d={line} stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChartCard({ data, tab, setTab, temFiltro }: { data: Overview; tab: ChartTab; setTab: (t: ChartTab) => void; temFiltro: boolean }) {
  const cfg: Record<ChartTab, { title: string; sub: string; key: keyof Overview["series"][number]; suffix: string; color: string; countKey?: keyof Overview["series"][number]; countLabel?: string }> = {
    uso: { title: "Uso do limite", sub: "% do limite liberado que está em uso, dia a dia", key: "usoLimitePct", suffix: "%", color: COLOR.primary },
    ativos: { title: "Clientes ativos", sub: "% da base com conta ativa, dia a dia", key: "ativosPct", suffix: "%", color: COLOR.success, countKey: "ativos", countLabel: "ativos" },
    encerramentos: { title: "Encerramentos", sub: "Contas encerradas por dia", key: "encerradosNoDia", suffix: "", color: COLOR.danger },
    saude: { title: "Nota de saúde", sub: "Evolução da nota de 0 a 100", key: "score", suffix: "", color: COLOR.warning },
  };
  const c = cfg[tab];
  const points = data.series.map((s) => ({ ...s, label: dayLabel(s.day) }));
  const hasHistory = data.historicoDisponivel && points.length >= 2;

  return (
    <div className="card pd-card pd-grow-2">
      <div className="pd-card-head">
        <div>
          <h3>{c.title}</h3>
          <p className="pd-card-sub" style={{ marginBottom: 0 }}>
            {c.sub}
          </p>
        </div>
        <div className="pd-seg" role="tablist" aria-label="Métrica do gráfico">
          {CHART_TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={tab === t.key ? "on" : ""} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
      {!hasHistory ? (
        <div className="chart-empty-state" style={{ height: 240 }}>
          <strong>{temFiltro ? "Histórico indisponível com filtro" : "O histórico está começando"}</strong>
          <span>
            {temFiltro
              ? "As fotos diárias guardam a base inteira. Remova o filtro de cidade/convênio para ver a evolução."
              : `Uma foto dos números é gravada todo dia. ${points.length === 1 ? `A primeira é de ${dayLabel(points[0].day)}. ` : ""}A evolução aparece a partir do segundo dia, sem dados inventados.`}
          </span>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={250}>
          <AreaChart data={points} margin={{ top: 10, right: 12, left: -14, bottom: 0 }}>
            <defs>
              <linearGradient id="pdArea" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={c.color} stopOpacity={0.35} />
                <stop offset="100%" stopColor={c.color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="label" tick={{ fill: MUTED, fontSize: 12 }} axisLine={{ stroke: GRID }} tickLine={false} minTickGap={24} />
            <YAxis tick={{ fill: MUTED, fontSize: 12 }} axisLine={false} tickLine={false} width={44} unit={c.suffix} domain={tab === "saude" ? [0, 100] : [0, "auto"]} />
            <Tooltip content={<ChartTooltip suffix={c.suffix} countKey={c.countKey as string | undefined} countLabel={c.countLabel} />} />
            <Area type="monotone" dataKey={c.key as string} stroke={c.color} strokeWidth={2.5} fill="url(#pdArea)" dot={{ r: 3, fill: c.color, strokeWidth: 0 }} activeDot={{ r: 5, fill: c.color, stroke: "#0b0f19", strokeWidth: 2 }} animationDuration={700} connectNulls />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

function HealthCard({ saude }: { saude: Overview["saude"] }) {
  if (!saude) {
    return (
      <div className="card pd-card pd-grow-1">
        <h3>Saúde da base</h3>
        <div className="pd-empty">
          <strong>Sem clientes para calcular</strong>
          <span>A nota aparece assim que houver clientes neste recorte.</span>
        </div>
      </div>
    );
  }
  const color = saude.band === "SAUDAVEL" ? COLOR.success : saude.band === "ATENCAO" ? COLOR.warning : COLOR.danger;
  const C = 2 * Math.PI * 54;
  return (
    <div className="card pd-card pd-grow-1">
      <h3>Saúde da base</h3>
      <div className="pd-health">
        <div className="pd-ring">
          <svg viewBox="0 0 132 132" width="132" height="132" fill="none" role="img" aria-label={`Nota de saúde da base: ${saude.score} de 100, ${saude.bandLabel}`}>
            <circle cx="66" cy="66" r="54" stroke="#232b3d" strokeWidth="12" />
            <circle cx="66" cy="66" r="54" stroke={color} strokeWidth="12" strokeLinecap="round" strokeDasharray={`${(C * saude.score) / 100} ${C}`} transform="rotate(-90 66 66)" style={{ transition: "stroke-dasharray 0.6s ease" }} />
          </svg>
          <div className="pd-ring-center">
            <strong>{saude.score}</strong>
            <span>de 100</span>
          </div>
        </div>
        <div>
          <div className="pd-band" style={{ color }}>
            {saude.bandLabel}
          </div>
          <DeltaChip delta={saude.delta} kind="abs" />
          <p className="pd-card-sub" style={{ margin: "6px 0 0" }}>
            Combina ativação, alcance, uso do limite e regularidade.
          </p>
        </div>
      </div>
      <div className="pd-label" style={{ marginTop: 14 }}>
        Como a nota é composta
      </div>
      {saude.components.map((c) => (
        <div key={c.key} className="pd-bar-row">
          <div className="pd-bar-head">
            <span>
              {c.label} <span className="pd-hint" style={{ display: "inline" }}>({c.peso}%)</span>
            </span>
            <span>
              {pct(c.valor)}
              {c.meta !== null ? ` · meta ${c.meta}%` : ""}
            </span>
          </div>
          <div className="pd-track">
            <div className="pd-fill" style={{ width: `${c.nota}%`, background: c.nota >= 70 ? COLOR.success : c.nota >= 40 ? COLOR.warning : COLOR.danger }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function RankingCard({ titulo, colunaNome, linhas, vazio }: { titulo: string; colunaNome: string; linhas: { nome: string; count: number; ativos: number; valor: number; link: string }[]; vazio: string }) {
  return (
    <div className="card pd-card pd-grow-1">
      <h3>{titulo}</h3>
      {linhas.length === 0 ? (
        <div className="pd-empty">
          <strong>Ainda sem dados</strong>
          <span>{vazio}</span>
          <Link to="/imports" className="btn secondary" style={{ textDecoration: "none" }}>
            Importar planilha
          </Link>
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>{colunaNome}</th>
                <th>Clientes</th>
                <th>Ativos</th>
                <th>Taxa</th>
                <th>Valor utilizado</th>
              </tr>
            </thead>
            <tbody>
              {linhas.map((l) => (
                <tr key={l.nome}>
                  <td>
                    <Link to={l.link}>{l.nome}</Link>
                  </td>
                  <td>{intFmt.format(l.count)}</td>
                  <td>{intFmt.format(l.ativos)}</td>
                  <td>{l.count ? pct((l.ativos / l.count) * 100) : "—"}</td>
                  <td>{currency.format(l.valor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Mini({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="pd-mini">
      <strong>{value}</strong>
      <span>{label}</span>
      {sub && <em>{sub}</em>}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="pd" aria-busy="true" aria-label="Carregando dashboard">
      <div className="pd-skel" style={{ height: 40, width: 320, marginBottom: 20 }} />
      <div className="pd-kpis">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="pd-skel" style={{ height: 110 }} />
        ))}
      </div>
      <div className="pd-row" style={{ marginTop: 16 }}>
        <div className="pd-skel pd-grow-2" style={{ height: 330 }} />
        <div className="pd-skel pd-grow-1" style={{ height: 330 }} />
      </div>
    </div>
  );
}

/** Tooltip minimalista compartilhado pelos gráficos, no tom visual dos cards do app. */
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
      <div className="chart-tooltip-label">{label ?? point.label}</div>
      <div className="chart-tooltip-value">
        {value}
        {suffix ? ` ${suffix}` : countLabel && !countKey ? ` ${countLabel}` : ""}
      </div>
      {sub && <div className="chart-tooltip-sub">{sub}</div>}
    </div>
  );
}

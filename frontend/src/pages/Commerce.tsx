import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Megaphone, ShoppingBag, Store, Users, Wallet } from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";

interface Categoria {
  category: string;
  label: string;
  clientes: number;
  compras: number;
  valor: number;
  lojistas: number;
}

interface CategoriasResponse {
  dias: number;
  dados: { totalTransacoes: number; primeira: string | null; ultima: string | null };
  totais: { clientes: number; compras: number; valor: number };
  categorias: Categoria[];
  todasCategorias: { key: string; label: string }[];
}

interface Lojista {
  id: string;
  name: string;
  category: string;
  categorySource: "AUTO" | "MANUAL";
  compras: number;
  clientes: number;
  valor: number;
  ultima: string | null;
}

const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const intFmt = new Intl.NumberFormat("pt-BR");
const dateFmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("pt-BR") : "—");

const PERIODOS: { dias: number; label: string }[] = [
  { dias: 0, label: "Todo o período" },
  { dias: 30, label: "30 dias" },
  { dias: 90, label: "90 dias" },
  { dias: 180, label: "180 dias" },
];

const COLOR = "#4f7cff";
const COLOR_ON = "#ff6907";
const GRID = "#2a3346";
const MUTED = "#9aa4b8";

export default function Commerce() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canEdit = user?.role === "ADMIN" || user?.role === "OPERATOR";

  const [dias, setDias] = useState(0);
  const [data, setData] = useState<CategoriasResponse | null>(null);
  const [lojistas, setLojistas] = useState<Lojista[]>([]);
  const [selecionadas, setSelecionadas] = useState<string[]>([]);
  const [busca, setBusca] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [criando, setCriando] = useState(false);
  const [salvando, setSalvando] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([
      api<CategoriasResponse>(`/purchases/categories?days=${dias}`),
      api<Lojista[]>(`/purchases/merchants?days=${dias}`),
    ])
      .then(([c, l]) => {
        setData(c);
        setLojistas(l);
        setError(null);
      })
      .catch((e) => setError(e.message));
  }, [dias]);

  useEffect(load, [load]);

  function alternar(cat: string) {
    setSelecionadas((s) => (s.includes(cat) ? s.filter((c) => c !== cat) : [...s, cat]));
  }

  async function criarCampanha(categorias: string[], rotulo: string) {
    setCriando(true);
    setError(null);
    try {
      const r = await api<{ total: number; autorizados: number; clientIds: string[] }>(
        `/purchases/audiencia?categorias=${categorias.join(",")}&days=${dias}`
      );
      if (r.total === 0) {
        setError("Nenhum cliente comprou nessas categorias no período.");
        return;
      }
      navigate("/campaigns/new", { state: { presetClientIds: r.clientIds, presetLabel: `Compraram em: ${rotulo}` } });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setCriando(false);
    }
  }

  async function mudarCategoria(l: Lojista, category: string) {
    setSalvando(l.id);
    setError(null);
    try {
      await api(`/purchases/merchants/${l.id}`, { method: "PATCH", body: { category } });
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSalvando(null);
    }
  }

  const labelDe = useMemo(() => new Map((data?.todasCategorias ?? []).map((c) => [c.key, c.label])), [data]);
  const categoriasChart = (data?.categorias ?? []).map((c) => ({ ...c, nome: c.label }));
  const lojistasFiltrados = lojistas.filter(
    (l) =>
      (selecionadas.length === 0 || selecionadas.includes(l.category)) &&
      (!busca.trim() || l.name.toLowerCase().includes(busca.trim().toLowerCase()))
  );
  const rotuloSelecao = selecionadas.map((c) => labelDe.get(c) ?? c).join(", ");

  if (!data) return error ? <div className="error-text">{error}</div> : <div>Carregando...</div>;

  const semDados = data.dados.totalTransacoes === 0;
  const ticket = data.totais.compras > 0 ? data.totais.valor / data.totais.compras : 0;

  return (
    <div className="pd">
      <div className="pd-head">
        <div>
          <h2 style={{ margin: 0 }}>Comércio credenciado</h2>
          <p className="pd-sub">
            {semDados
              ? "Nenhuma compra importada ainda."
              : `${intFmt.format(data.dados.totalTransacoes)} transações importadas, de ${dateFmt(data.dados.primeira)} a ${dateFmt(data.dados.ultima)}.`}
          </p>
        </div>
        <div className="pd-seg" role="group" aria-label="Período">
          {PERIODOS.map((p) => (
            <button key={p.dias} type="button" className={dias === p.dias ? "on" : ""} aria-pressed={dias === p.dias} onClick={() => setDias(p.dias)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="error-text">{error}</div>}

      {semDados ? (
        <div className="card pd-card">
          <div className="pd-empty">
            <strong>Importe a aba “Todas as Compras” para ver quem compra onde</strong>
            <span>
              Exporte essa aba da planilha como .csv e envie em Importações, escolhendo o formato “Compras”. Os clientes
              precisam já estar na base (a ligação é pelo CPF/CNPJ); se faltar algum, é só reenviar o arquivo depois,
              sem duplicar.
            </span>
            <Link to="/imports" className="btn" style={{ textDecoration: "none" }}>
              Ir para Importações
            </Link>
          </div>
        </div>
      ) : (
        <>
          <div className="pd-kpis">
            <Kpi icon={<Users size={17} />} cor="#9b87f5" label="Clientes que compraram" value={intFmt.format(data.totais.clientes)} />
            <Kpi icon={<ShoppingBag size={17} />} cor="#4f7cff" label="Compras no comércio" value={intFmt.format(data.totais.compras)} />
            <Kpi icon={<Wallet size={17} />} cor="#ff6907" label="Valor comprado" value={currency.format(data.totais.valor)} />
            <Kpi icon={<Store size={17} />} cor="#35c17a" label="Ticket médio" value={currency.format(ticket)} />
          </div>

          <div className="pd-row">
            <div className="card pd-card pd-grow-2">
              <div className="pd-card-head">
                <div>
                  <h3>Clientes por categoria</h3>
                  <p className="pd-card-sub" style={{ marginBottom: 0 }}>
                    Clique numa barra (ou nos botões abaixo) para escolher categorias e criar a campanha.
                  </p>
                </div>
              </div>
              {categoriasChart.length === 0 ? (
                <div className="pd-empty">
                  <strong>Sem compras no comércio neste período</strong>
                  <span>Tente “Todo o período”.</span>
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={Math.max(180, categoriasChart.length * 38)}>
                  <BarChart data={categoriasChart} layout="vertical" margin={{ top: 4, right: 24, left: 8, bottom: 4 }} barCategoryGap={10}>
                    <CartesianGrid stroke={GRID} horizontal={false} />
                    <XAxis type="number" tick={{ fill: MUTED, fontSize: 12 }} axisLine={{ stroke: GRID }} tickLine={false} allowDecimals={false} />
                    <YAxis type="category" dataKey="nome" tick={{ fill: MUTED, fontSize: 12 }} axisLine={false} tickLine={false} width={170} />
                    <Tooltip content={<CategoriaTooltip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                    <Bar dataKey="clientes" radius={[0, 4, 4, 0]} maxBarSize={22} cursor="pointer" animationDuration={600} onClick={(d: any) => alternar(d.category)}>
                      {categoriasChart.map((c) => (
                        <Cell key={c.category} fill={selecionadas.includes(c.category) ? COLOR_ON : COLOR} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            <div className="card pd-card pd-grow-1">
              <h3>Campanha por categoria</h3>
              <p className="pd-card-sub">Envie só para quem usa o cartão nesse tipo de comércio. Opt-outs são excluídos automaticamente.</p>
              <div className="pd-chips">
                {data.categorias.map((c) => (
                  <button
                    key={c.category}
                    type="button"
                    className={`pd-chip ${selecionadas.includes(c.category) ? "on" : ""}`}
                    aria-pressed={selecionadas.includes(c.category)}
                    onClick={() => alternar(c.category)}
                  >
                    {c.label} <strong>{intFmt.format(c.clientes)}</strong>
                  </button>
                ))}
              </div>
              <button
                className="btn"
                style={{ marginTop: 14, display: "inline-flex", alignItems: "center", gap: 6, minHeight: 40 }}
                disabled={selecionadas.length === 0 || criando}
                onClick={() => criarCampanha(selecionadas, rotuloSelecao)}
              >
                <Megaphone size={14} />
                {criando ? "Carregando..." : selecionadas.length === 0 ? "Escolha uma categoria" : `Criar campanha (${selecionadas.length})`}
              </button>
              {selecionadas.length > 0 && (
                <button className="btn secondary" style={{ marginTop: 14, marginLeft: 8, minHeight: 40 }} onClick={() => setSelecionadas([])}>
                  Limpar
                </button>
              )}
            </div>
          </div>

          <div className="card pd-card">
            <div className="pd-card-head">
              <div>
                <h3>Lojistas</h3>
                <p className="pd-card-sub" style={{ marginBottom: 0 }}>
                  A categoria é deduzida do nome. {canEdit ? "Corrija na lista se estiver errada: sua escolha não é sobrescrita em novas importações." : "Peça a um operador para corrigir categorias erradas."}
                </p>
              </div>
              <input
                type="search"
                placeholder="Buscar lojista"
                aria-label="Buscar lojista"
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                style={{ maxWidth: 240 }}
              />
            </div>
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>Lojista</th>
                    <th>Categoria</th>
                    <th>Clientes</th>
                    <th>Compras</th>
                    <th>Valor</th>
                    <th>Última compra</th>
                  </tr>
                </thead>
                <tbody>
                  {lojistasFiltrados.map((l) => (
                    <tr key={l.id}>
                      <td>{l.name}</td>
                      <td>
                        <select
                          value={l.category}
                          disabled={!canEdit || salvando === l.id}
                          onChange={(e) => mudarCategoria(l, e.target.value)}
                          aria-label={`Categoria de ${l.name}`}
                        >
                          {data.todasCategorias.map((c) => (
                            <option key={c.key} value={c.key}>
                              {c.label}
                            </option>
                          ))}
                        </select>{" "}
                        {l.categorySource === "MANUAL" && <span className="badge">manual</span>}
                      </td>
                      <td>{intFmt.format(l.clientes)}</td>
                      <td>{intFmt.format(l.compras)}</td>
                      <td>{currency.format(l.valor)}</td>
                      <td>{dateFmt(l.ultima)}</td>
                    </tr>
                  ))}
                  {lojistasFiltrados.length === 0 && (
                    <tr>
                      <td colSpan={6} style={{ color: "var(--text-muted)" }}>
                        Nenhum lojista neste filtro.
                      </td>
                    </tr>
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

function Kpi({ icon, cor, label, value }: { icon: React.ReactNode; cor: string; label: string; value: string }) {
  return (
    <div className="pd-kpi kpi-animate">
      <div className="pd-kpi-top">
        <span className="pd-kpi-icon" style={{ color: cor, background: `${cor}22` }}>
          {icon}
        </span>
        <span className="pd-kpi-label">{label}</span>
      </div>
      <div className="pd-kpi-value">{value}</div>
    </div>
  );
}

function CategoriaTooltip({ active, payload }: { active?: boolean; payload?: any[] }) {
  if (!active || !payload?.length) return null;
  const c = payload[0].payload as Categoria;
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-label">{c.label}</div>
      <div className="chart-tooltip-value">{intFmt.format(c.clientes)} clientes</div>
      <div className="chart-tooltip-sub">
        {intFmt.format(c.compras)} compras · {currency.format(c.valor)} · {c.lojistas} lojista(s)
      </div>
    </div>
  );
}

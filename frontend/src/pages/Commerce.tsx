import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  todasCategorias: { key: string; label: string; mensagem: string }[];
  mensagemVariasCategorias: string;
}

interface Audiencia {
  total: number;
  autorizados: number;
  porFrequencia: number[];
  clientIds: string[];
  mensagem: string;
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

/** Prévia da mensagem com valores de exemplo (o envio usa os dados reais de cada cliente). */
function previaMensagem(texto: string): string {
  const exemplo: Record<string, string> = { nome: "Maria", saldo: "R$ 850,00", limite: "R$ 1.500,00", percentual: "45", cidade: "Boquim" };
  return texto.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => exemplo[k] ?? m);
}

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
  const [freq, setFreq] = useState(1);
  const [canal, setCanal] = useState<"WHATSAPP" | "SMS">("WHATSAPP");
  const [aud, setAud] = useState<Audiencia | null>(null);
  const [carregandoAud, setCarregandoAud] = useState(false);
  const [mensagem, setMensagem] = useState("");
  const [mensagemEditada, setMensagemEditada] = useState(false);
  const editadaRef = useRef(false); // espelho do estado para o efeito não refazer a busca ao editar o texto

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

  // Público real da seleção (categorias + frequência mínima): recalcula quando algo muda.
  useEffect(() => {
    if (selecionadas.length === 0) {
      setAud(null);
      return;
    }
    let cancelado = false;
    setCarregandoAud(true);
    api<Audiencia>(`/purchases/audiencia?categorias=${selecionadas.join(",")}&days=${dias}&minCompras=${freq}`)
      .then((r) => {
        if (cancelado) return;
        setAud(r);
        // A mensagem acompanha a seleção até o operador editar o texto.
        setMensagem((atual) => (editadaRef.current && atual ? atual : r.mensagem));
        setError(null);
      })
      .catch((e) => !cancelado && setError(e.message))
      .finally(() => !cancelado && setCarregandoAud(false));
    return () => {
      cancelado = true;
    };
  }, [selecionadas, dias, freq]);

  function criarCampanha() {
    if (!aud || aud.total === 0) return;
    setCriando(true);
    navigate("/campaigns/new", {
      state: {
        presetClientIds: aud.clientIds,
        presetLabel: `Compraram em: ${rotuloSelecao}${freq > 1 ? ` (${freq}+ compras)` : ""}`,
        presetMessage: mensagem || aud.mensagem,
        presetChannel: canal,
      },
    });
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

            <div className="card pd-card pd-grow-1" style={{ borderColor: "#2c3a63" }}>
              <h3>Montar campanha por comércio</h3>
              <p className="pd-card-sub">Público: quem costuma comprar nas categorias escolhidas. Opt-outs ficam de fora automaticamente.</p>

              <div className="pd-label">1 · Categorias</div>
              <div className="pd-chips">
                {data.categorias.map((c) => (
                  <button key={c.category} type="button" className={`pd-chip ${selecionadas.includes(c.category) ? "on" : ""}`} aria-pressed={selecionadas.includes(c.category)} onClick={() => alternar(c.category)}>
                    {c.label} <strong>{intFmt.format(c.clientes)}</strong>
                  </button>
                ))}
              </div>

              <div className="pd-label" style={{ marginTop: 14 }}>2 · Frequência mínima</div>
              <div className="pd-seg" role="group" aria-label="Frequência mínima de compras" style={{ display: "flex" }}>
                {[1, 2, 3].map((n) => (
                  <button key={n} type="button" style={{ flex: 1 }} className={freq === n ? "on" : ""} aria-pressed={freq === n} onClick={() => setFreq(n)}>
                    {n}+ {n === 1 ? "compra" : "compras"}
                    {aud ? ` (${intFmt.format(aud.porFrequencia[n - 1] ?? 0)})` : ""}
                  </button>
                ))}
              </div>

              <div className="pd-label" style={{ marginTop: 14 }}>3 · Canal</div>
              <div className="pd-seg" role="group" aria-label="Canal de envio" style={{ display: "flex" }}>
                {([["WHATSAPP", "WhatsApp"], ["SMS", "SMS"]] as const).map(([k, l]) => (
                  <button key={k} type="button" style={{ flex: 1 }} className={canal === k ? "on" : ""} aria-pressed={canal === k} onClick={() => setCanal(k)}>
                    {l}
                  </button>
                ))}
              </div>

              <div className="pd-audience">
                <span className="pd-card-sub" style={{ margin: 0 }}>Público estimado</span>
                <strong>
                  {selecionadas.length === 0 ? "Escolha uma categoria" : carregandoAud && !aud ? "Calculando..." : `${intFmt.format(aud?.total ?? 0)} ${(aud?.total ?? 0) === 1 ? "cliente" : "clientes"}`}
                </strong>
                {aud && aud.total > 0 && (
                  <span className="pd-card-sub" style={{ margin: 0 }}>
                    {intFmt.format(aud.autorizados)} podem receber (sem opt-out). Quem compra em várias categorias é contado uma vez.
                  </span>
                )}
                {aud && aud.total === 0 && <span className="pd-card-sub" style={{ margin: 0 }}>Ninguém atende a esse critério.</span>}
              </div>

              <div className="pd-label" style={{ marginTop: 14 }}>4 · Mensagem sugerida (editável)</div>
              <textarea
                aria-label="Mensagem da campanha"
                rows={4}
                value={mensagem}
                disabled={selecionadas.length === 0}
                onChange={(e) => {
                  setMensagem(e.target.value);
                  editadaRef.current = true;
                  setMensagemEditada(true);
                }}
                style={{ width: "100%", resize: "vertical" }}
              />
              {mensagem && <p className="pd-hint">Prévia: {previaMensagem(mensagem)}</p>}
              <p className="pd-hint">
                Variáveis: {"{{nome}}"}, {"{{saldo}}"}, {"{{limite}}"}, {"{{percentual}}"}, {"{{cidade}}"}. Você ainda revisa tudo no assistente antes de enviar.
              </p>
              {mensagemEditada && (
                <button type="button" className="btn secondary" style={{ minHeight: 36, marginBottom: 10 }} onClick={() => { editadaRef.current = false; setMensagemEditada(false); if (aud) setMensagem(aud.mensagem); }}>
                  Voltar à mensagem sugerida
                </button>
              )}

              <button className="btn" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, minHeight: 44, width: "100%" }} disabled={!aud || aud.total === 0 || criando} onClick={criarCampanha}>
                <Megaphone size={14} />
                {!aud || aud.total === 0 ? "Sem público para enviar" : `Criar campanha para ${intFmt.format(aud.total)} ${aud.total === 1 ? "cliente" : "clientes"}`}
              </button>
              {selecionadas.length > 0 && (
                <button className="btn secondary" style={{ marginTop: 8, minHeight: 36 }} onClick={() => setSelecionadas([])}>
                  Limpar seleção
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

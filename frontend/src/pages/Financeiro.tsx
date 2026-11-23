import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Bar, BarChart, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";

type Confianca = "alta" | "media" | "baixa";
interface Resumo {
  lucro: number;
  antecipacoes: number;
  usos: number;
  usaram: number;
  ticketMedio: number | null;
  lucroPorUsuario: number | null;
}
interface Progresso {
  pct: number;
  atingida: boolean;
}
interface Resp {
  disponivel: boolean;
  ultimoDiaExtrato?: string;
  extratoEmDia?: boolean;
  diasDefasagem?: number | null;
  periodo?: { mes: string; rotulo: string; diaAtual: number; diasNoMes: number };
  atual?: Resumo;
  anterior?: Resumo;
  variacoes?: Record<"lucro" | "antecipacoes" | "usos" | "ticketMedio" | "lucroPorUsuario", number | null>;
  semanas?: { semana: number; atual: number; anterior: number }[];
  porCidade?: { key: string; cidade: string; lucro: number; pct: number }[];
  porPerfil?: { key: string; label: string; lucro: number; pct: number }[];
  metas?: { lucro: number | null; usos: number | null; disponivel: boolean };
  progresso?: { lucro: Progresso | null; usos: Progresso | null };
  projecao?: { lucro: { valor: number; confianca: Confianca }; usos: { valor: number; confianca: Confianca } };
}

const intFmt = new Intl.NumberFormat("pt-BR");
const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const brl2 = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const p1 = (n: number) => n.toFixed(1).replace(".", ",");
const dia = (iso: string) => iso.split("-").reverse().join("/");
const CONF: Record<Confianca, string> = { alta: "confiança alta", media: "confiança média", baixa: "confiança baixa" };

function Delta({ pct }: { pct: number | null | undefined }) {
  if (pct === null || pct === undefined) return <span className="pd-delta flat">sem base</span>;
  const classe = Math.abs(pct) < 1 ? "flat" : pct > 0 ? "up" : "down";
  const Icone = Math.abs(pct) < 1 ? Minus : pct > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`pd-delta ${classe}`}>
      <Icone size={12} /> {pct > 0 ? "+" : pct < 0 ? "−" : ""}
      {p1(Math.abs(pct))}%
    </span>
  );
}

function Kpi({ label, valor, sub, pct }: { label: string; valor: string; sub?: string; pct: number | null | undefined }) {
  return (
    <div className="pd-kpi">
      <div className="pd-kpi-top"><span className="pd-kpi-label">{label}</span></div>
      <div className="pd-kpi-body">
        <div>
          <div className="pd-kpi-value">{valor}</div>
          {sub && <div className="pd-kpi-sub">{sub}</div>}
        </div>
        <Delta pct={pct} />
      </div>
    </div>
  );
}

function Barra({ rotulo, direita, pct, cor }: { rotulo: string; direita: string; pct: number; cor: string }) {
  return (
    <div className="pd-bar-row">
      <div className="pd-bar-head"><span>{rotulo}</span><span>{direita}</span></div>
      <div className="pd-track"><div className="pd-fill" style={{ width: `${Math.min(100, Math.max(pct, pct > 0 ? 1.5 : 0))}%`, background: cor }} /></div>
    </div>
  );
}

/** Financeiro e metas: lucro das antecipações (juros) do mês do último extrato contra o mês anterior. GET /api/negocio/financeiro. */
export default function Financeiro() {
  const { user } = useAuth();
  const [data, setData] = useState<Resp | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [editando, setEditando] = useState(false);
  const [metaLucro, setMetaLucro] = useState("");
  const [metaUsos, setMetaUsos] = useState("");
  const [salvando, setSalvando] = useState(false);

  const load = useCallback(() => {
    api<Resp>("/negocio/financeiro").then(setData).catch((e) => setErro(e.message));
  }, []);
  useEffect(load, [load]);

  async function salvarMetas() {
    const num = (v: string) => (v.trim() === "" ? null : Number(v.replace(/\./g, "").replace(",", ".")));
    const lucro = num(metaLucro);
    const usos = num(metaUsos);
    if ((lucro !== null && !(lucro > 0)) || (usos !== null && !(usos > 0 && Number.isInteger(usos)))) return setErro("Informe valores positivos (usos em número inteiro) ou deixe em branco.");
    setSalvando(true);
    setErro(null);
    try {
      await api("/negocio/metas", { method: "PUT", body: { lucro, usos } });
      setEditando(false);
      load();
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setSalvando(false);
    }
  }

  if (!data && !erro) return <div className="pd"><div className="pd-skel" style={{ height: 300 }} /></div>;
  if (data && !data.disponivel) {
    return (
      <div className="pd">
        <h2 style={{ margin: 0 }}>Financeiro e metas</h2>
        <div className="card pd-card"><p className="pd-card-sub">Importe o extrato de compras (aba "Todas as Compras") para ver o lucro das antecipações.</p></div>
      </div>
    );
  }
  if (!data || !data.atual || !data.anterior || !data.periodo || !data.variacoes || !data.metas || !data.progresso || !data.projecao) {
    return <div className="pd">{erro && <div className="error-text">{erro}</div>}</div>;
  }

  const { atual, anterior, periodo, variacoes, metas, progresso, projecao } = data;
  const semanas = (data.semanas ?? []).map((s) => ({ nome: `Sem ${s.semana}`, "Mês anterior": s.anterior, "Mês atual": s.atual }));
  const ehAdmin = user?.role === "ADMIN";

  const MetaLinha = ({ titulo, valor, meta, prog, proj, fmt }: { titulo: string; valor: number; meta: number | null; prog: Progresso | null; proj: { valor: number; confianca: Confianca }; fmt: (n: number) => string }) => (
    <div style={{ marginBottom: 16 }}>
      {prog && meta ? (
        <Barra rotulo={`${titulo}: ${fmt(valor)} de ${fmt(meta)}`} direita={`${p1(prog.pct)}%`} pct={prog.pct} cor={prog.atingida ? "#35c17a" : "#4f7cff"} />
      ) : (
        <div className="pd-bar-head"><span>{titulo}: {fmt(valor)}</span><span>sem meta</span></div>
      )}
      <span className="pd-hint">
        Projeção do fechamento: {fmt(proj.valor)} ({CONF[proj.confianca]}){meta ? ` · ${p1((proj.valor / meta) * 100)}% da meta` : ""}
      </span>
    </div>
  );

  return (
    <div className="pd">
      <div className="pd-head">
        <div>
          <h2 style={{ margin: 0 }}>Financeiro e metas</h2>
          <p className="pd-sub">
            {periodo.rotulo[0].toUpperCase() + periodo.rotulo.slice(1)} até o dia {periodo.diaAtual}, contra o mês anterior até o mesmo dia. Lucro = juros das antecipações.
          </p>
        </div>
      </div>
      {erro && <div className="error-text">{erro}</div>}

      <div className="card pd-card" style={{ borderColor: "var(--warning)", background: "var(--warning-soft)" }}>
        <span style={{ fontSize: 13 }}>
          <strong style={{ color: "var(--warning)" }}>Só antecipação entra no lucro.</strong> O lucro da compra à vista (taxa do lojista) é desconhecido e fica de fora, em vez de contar como zero.
          {!data.extratoEmDia && ` O extrato está parado há ${data.diasDefasagem} dias: os números valem até ${dia(data.ultimoDiaExtrato!)}.`}
        </span>
      </div>

      <div className="pd-kpis">
        <Kpi label="Lucro (juros)" valor={brl.format(atual.lucro)} sub={`mês anterior: ${brl.format(anterior.lucro)}`} pct={variacoes.lucro} />
        <Kpi label="Antecipações" valor={intFmt.format(atual.antecipacoes)} sub={`${intFmt.format(atual.usos)} usos no total`} pct={variacoes.antecipacoes} />
        <Kpi label="Ticket médio da antecipação" valor={atual.ticketMedio === null ? "—" : brl2.format(atual.ticketMedio)} pct={variacoes.ticketMedio} />
        <Kpi label="Lucro por cliente que usou" valor={atual.lucroPorUsuario === null ? "—" : brl2.format(atual.lucroPorUsuario)} sub={`${intFmt.format(atual.usaram)} clientes usaram`} pct={variacoes.lucroPorUsuario} />
      </div>

      <div className="pd-row">
        <div className="card pd-card pd-grow-2">
          <h3>Lucro por semana do mês</h3>
          <p className="pd-card-sub">Semanas: dias 1–7, 8–14, 15–21 e 22 em diante. O mês anterior vai só até o mesmo dia do mês.</p>
          <div style={{ height: 230 }}>
            <ResponsiveContainer>
              <BarChart data={semanas} margin={{ top: 4, right: 4, bottom: 0, left: -4 }}>
                <XAxis dataKey="nome" tick={{ fill: "#9aa4b8", fontSize: 12 }} stroke="#2a3346" />
                <YAxis tick={{ fill: "#9aa4b8", fontSize: 11 }} stroke="#2a3346" tickFormatter={(v) => brl.format(Number(v))} width={70} />
                <Tooltip contentStyle={{ background: "#121826", border: "1px solid #232b3d", borderRadius: 8 }} formatter={(v) => brl2.format(Number(v))} />
                <Legend wrapperStyle={{ fontSize: 12, color: "#9aa4b8" }} />
                <Bar dataKey="Mês anterior" fill="#3a4560" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Mês atual" fill="#4f7cff" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card pd-card pd-grow-1">
          <div className="pd-card-head">
            <h3 style={{ margin: 0 }}>Metas do mês</h3>
            {ehAdmin && metas.disponivel && !editando && (
              <button className="btn secondary" onClick={() => { setMetaLucro(metas.lucro ? String(metas.lucro) : ""); setMetaUsos(metas.usos ? String(metas.usos) : ""); setEditando(true); }}>Definir metas</button>
            )}
          </div>
          {!metas.disponivel && <p className="pd-card-sub">Metas indisponíveis: falta criar a coluna no banco (SQL 2026-11-metas.sql).</p>}
          {editando ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <label style={{ fontSize: 13 }}>Meta de lucro do mês (R$)<input value={metaLucro} onChange={(e) => setMetaLucro(e.target.value)} placeholder="ex.: 60000" inputMode="decimal" style={{ width: "100%" }} /></label>
              <label style={{ fontSize: 13 }}>Meta de usos do mês<input value={metaUsos} onChange={(e) => setMetaUsos(e.target.value)} placeholder="ex.: 7000" inputMode="numeric" style={{ width: "100%" }} /></label>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn" disabled={salvando} onClick={salvarMetas}>{salvando ? "Salvando..." : "Salvar"}</button>
                <button className="btn secondary" disabled={salvando} onClick={() => setEditando(false)}>Cancelar</button>
              </div>
              <span className="pd-hint">Deixe em branco para remover a meta.</span>
            </div>
          ) : (
            metas.disponivel && (
              <>
                <MetaLinha titulo="Lucro" valor={atual.lucro} meta={metas.lucro} prog={progresso.lucro} proj={projecao.lucro} fmt={(n) => brl.format(n)} />
                <MetaLinha titulo="Usos" valor={atual.usos} meta={metas.usos} prog={progresso.usos} proj={projecao.usos} fmt={(n) => intFmt.format(Math.round(n))} />
                <p className="pd-hint">A projeção é linear (ritmo do mês até agora). O uso se concentra na abertura do ciclo de cada cidade, então ela oscila no meio do mês.</p>
              </>
            )
          )}
        </div>
      </div>

      <div className="pd-row">
        <div className="card pd-card pd-grow-1">
          <h3>Lucro por cidade</h3>
          <p className="pd-card-sub">Participação no lucro do mês até agora. Cidade do cliente.</p>
          {(data.porCidade ?? []).map((c) => (
            <Barra key={c.key} rotulo={c.cidade} direita={`${brl.format(c.lucro)} · ${p1(c.pct)}%`} pct={c.pct} cor="#4f7cff" />
          ))}
          {(data.porCidade ?? []).length === 0 && <p className="pd-card-sub">Sem lucro por cidade no período.</p>}
        </div>
        <div className="card pd-card pd-grow-1">
          <h3>Lucro por perfil de renda</h3>
          <p className="pd-card-sub">PF1 a PF4 pelo limite total do cliente. <Link to="/segments">Ver segmentos</Link></p>
          {(data.porPerfil ?? []).map((p) => (
            <Barra key={p.key} rotulo={p.label} direita={`${brl.format(p.lucro)} · ${p1(p.pct)}%`} pct={p.pct} cor="#ff6907" />
          ))}
          {(data.porPerfil ?? []).length === 0 && <p className="pd-card-sub">Sem lucro por perfil no período.</p>}
        </div>
      </div>
      <p className="pd-note">O retorno de cada campanha (lucro incremental sobre o custo) fica no relatório da própria campanha.</p>
    </div>
  );
}

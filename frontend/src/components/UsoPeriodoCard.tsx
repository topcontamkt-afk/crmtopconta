import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "../api/client";

interface Totais {
  clientes: number;
  usos: number;
  valorMovimentado: number;
  antecipacoes: { qtd: number; valor: number };
  comprasAVista: { qtd: number; valor: number };
  lucroJuros: number;
}
interface Resp {
  periodo: { de: string; ate: string; dias: number };
  anterior: { de: string; ate: string };
  extrato: { primeiro: string | null; ultimo: string | null; cobrePeriodo: boolean };
  totais: Totais;
  variacao: { clientes: number | null; usos: number | null; valorMovimentado: number | null; lucroJuros: number | null };
  serie: { dia: string; usos: number; clientes: number; valor: number }[];
  adesao: { meta: number; base: number; usaram: number; taxa: number | null; faixa: Faixa | null; faltam: number; anterior: number | null; variacaoPontos: number | null };
  cidades: { cidade: string; base: number; usaram: number; taxa: number | null; faixa: Faixa | null; faltam: number; usos: number; valor: number }[];
}
type Faixa = "SAUDAVEL" | "ATENCAO" | "BAIXA";

const FAIXA_COR: Record<Faixa, string> = { SAUDAVEL: "#35c17a", ATENCAO: "#e0a233", BAIXA: "#e15b5b" };
const FAIXA_TXT: Record<Faixa, string> = { SAUDAVEL: "Meta atingida", ATENCAO: "Atenção", BAIXA: "Abaixo da meta" };
const pctBr = (n: number) => `${n.toFixed(1).replace(".", ",")}%`;

const GRID = "#2a3346";
const MUTED = "#9aa4b8";
const brl = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const int = (n: number) => n.toLocaleString("pt-BR");
const br = (iso: string) => iso.split("-").reverse().join("/");

function Delta({ v }: { v: number | null }) {
  if (v === null) return <span className="pd-delta flat">sem base</span>;
  const cls = v > 0 ? "up" : v < 0 ? "down" : "flat";
  return <span className={`pd-delta ${cls}`}>{v > 0 ? "+" : ""}{String(v).replace(".", ",")}%</span>;
}

function Mini({ label, value, sub, delta }: { label: string; value: string; sub?: string; delta?: number | null }) {
  return (
    <div className="pd-mini">
      <div className="pd-kpi-label">{label}</div>
      <div className="pd-kpi-value" style={{ fontSize: 20 }}>{value}</div>
      <div className="pd-kpi-sub">
        {delta !== undefined && <Delta v={delta} />} {sub}
      </div>
    </div>
  );
}

/**
 * Uso REAL no período (extrato de compras: antecipação e compra à vista), com as datas do filtro do painel ou os últimos
 * 7/30/90 dias. Compara com o período anterior de mesma duração e mostra o uso dia a dia e as cidades que mais usaram.
 */
export default function UsoPeriodoCard({ days, de, ate, cidade, convenio }: { days: number; de: string; ate: string; cidade: string; convenio: string }) {
  const [d, setD] = useState<Resp | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    const qs = new URLSearchParams({ days: String(days) });
    if (de) qs.set("de", de);
    if (ate) qs.set("ate", ate);
    if (cidade) qs.set("cidade", cidade);
    if (convenio) qs.set("empresaConveniada", convenio);
    let vivo = true;
    api<Resp>(`/dashboard/uso-periodo?${qs}`)
      .then((r) => vivo && (setD(r), setErro(null)))
      .catch((e) => vivo && setErro(e.message));
    return () => {
      vivo = false;
    };
  }, [days, de, ate, cidade, convenio]);

  if (erro) return <div className="card pd-card pd-grow-1 error-text">Uso no período: {erro}</div>;
  if (!d) return null;
  const t = d.totais;
  const semDados = t.usos === 0;
  const pontos = d.serie.map((s) => ({ ...s, label: s.dia.slice(8, 10) + "/" + s.dia.slice(5, 7) }));

  return (
    <div className="pd-row">
      <div className="card pd-card pd-grow-2">
        <div className="pd-card-head">
          <div>
            <h3>Uso no período</h3>
            <p className="pd-card-sub" style={{ marginBottom: 0 }}>
              {br(d.periodo.de)} a {br(d.periodo.ate)} ({d.periodo.dias} dia{d.periodo.dias === 1 ? "" : "s"}) · antecipações e compras à vista · variação contra {br(d.anterior.de)} a {br(d.anterior.ate)}
            </p>
          </div>
        </div>

        {d.extrato.ultimo && !d.extrato.cobrePeriodo && (
          <p className="pd-note" style={{ margin: "0 0 10px", color: "var(--warning)" }}>
            O extrato de compras vai até {br(d.extrato.ultimo)}: os dias seguintes ainda não têm dados.
          </p>
        )}

        <div className="pd-minis">
          <Mini label="Clientes que usaram" value={int(t.clientes)} delta={d.variacao.clientes} sub={d.adesao.taxa !== null ? `${pctBr(d.adesao.taxa)} da base ativa` : undefined} />
          <Mini label="Usos" value={int(t.usos)} delta={d.variacao.usos} sub={`${int(t.antecipacoes.qtd)} antecipações · ${int(t.comprasAVista.qtd)} compras`} />
          <Mini label="Valor movimentado" value={brl(t.valorMovimentado)} delta={d.variacao.valorMovimentado} sub={`${brl(t.antecipacoes.valor)} em antecipações`} />
          <Mini label="Lucro (juros)" value={brl(t.lucroJuros)} delta={d.variacao.lucroJuros} sub="só antecipações" />
        </div>

        <Adesao a={d.adesao} />

        {semDados ? (
          <div className="chart-empty-state" style={{ height: 180 }}>
            <strong>Sem uso neste período</strong>
            <span>O extrato de compras não tem antecipações nem compras entre estas datas{cidade || convenio ? " para o recorte escolhido" : ""}.</span>
          </div>
        ) : (
          <div style={{ width: "100%", height: 220, marginTop: 8 }}>
            <ResponsiveContainer>
              <BarChart data={pontos} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="label" tick={{ fill: MUTED, fontSize: 11 }} axisLine={{ stroke: GRID }} tickLine={false} minTickGap={18} />
                <YAxis tick={{ fill: MUTED, fontSize: 12 }} axisLine={false} tickLine={false} width={44} allowDecimals={false} />
                <Tooltip
                  cursor={{ fill: "rgba(255,255,255,0.04)" }}
                  contentStyle={{ background: "#171d2b", border: `1px solid ${GRID}` }}
                  formatter={((v: unknown, _n: unknown, item: any) => [`${int(Number(v))} usos · ${int(item.payload.clientes)} clientes · ${brl(item.payload.valor)}`, "Uso"]) as any}
                  labelFormatter={(l) => `Dia ${l}`}
                />
                <Bar dataKey="usos" fill="#ff6907" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div className="card pd-card pd-grow-1">
        <h3>Adesão por cidade</h3>
        <p className="pd-card-sub">Clientes ativos com limite que usaram o saldo no período, por cidade. Meta: {d.adesao.meta}% da base.</p>
        {d.cidades.length === 0 ? (
          <p className="pd-hint">Sem clientes ativos com limite neste recorte.</p>
        ) : (
          d.cidades.map((c) => (
            <div key={c.cidade} className="pd-bar-row">
              <div className="pd-bar-head">
                <span>{c.cidade}</span>
                <span style={{ color: c.faixa ? FAIXA_COR[c.faixa] : undefined, fontWeight: 600 }}>{c.taxa !== null ? pctBr(c.taxa) : "—"}</span>
              </div>
              <div className="pd-rec-track">
                <span className="pd-rec-fill" style={{ width: `${Math.min(100, c.taxa ?? 0)}%`, background: c.faixa ? FAIXA_COR[c.faixa] : MUTED }} />
                <span className="pd-rec-meta" style={{ left: `${d.adesao.meta}%` }} />
              </div>
              <span className="pd-hint">
                {int(c.usaram)} de {int(c.base)} clientes usaram ·{" "}
                {c.faltam > 0 ? <strong>faltam {int(c.faltam)} para a meta</strong> : <span style={{ color: FAIXA_COR.SAUDAVEL }}>meta atingida</span>} · {int(c.usos)} usos · {brl(c.valor)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** Adesão geral: % da base ATIVA (com limite) que usou o saldo no período. Meta da TopConta: 80%. */
function Adesao({ a }: { a: Resp["adesao"] }) {
  if (a.taxa === null || !a.faixa) return null;
  const cor = FAIXA_COR[a.faixa];
  return (
    <div className="pd-rec">
      <div className="pd-rec-head">
        <div>
          <div className="pd-kpi-label">Adesão da base ativa ao saldo</div>
          <div className="pd-kpi-value" style={{ color: cor }}>
            {pctBr(a.taxa)} <span className="pd-rec-badge" style={{ color: cor, borderColor: cor }}>{FAIXA_TXT[a.faixa]}</span>
          </div>
        </div>
        <div className="pd-rec-side">
          <span>Meta: <strong>{a.meta}%</strong> da base ativa</span>
          {a.variacaoPontos !== null && (
            <span className={`pd-delta ${a.variacaoPontos > 0 ? "up" : a.variacaoPontos < 0 ? "down" : "flat"}`}>
              {a.variacaoPontos > 0 ? "+" : ""}{String(a.variacaoPontos).replace(".", ",")} p.p. vs. período anterior
            </span>
          )}
        </div>
      </div>
      <div className="pd-rec-track big">
        <span className="pd-rec-fill" style={{ width: `${Math.min(100, a.taxa)}%`, background: cor }} />
        <span className="pd-rec-meta" style={{ left: `${a.meta}%` }} title={`Meta ${a.meta}%`} />
      </div>
      <p className="pd-hint" style={{ marginTop: 6 }}>
        {int(a.usaram)} de {int(a.base)} clientes ativos com limite usaram o saldo no período.{" "}
        {a.faltam > 0 ? <strong>Faltam {int(a.faltam)} clientes para chegar a {a.meta}%.</strong> : <strong style={{ color: FAIXA_COR.SAUDAVEL }}>Meta atingida.</strong>}
      </p>
    </div>
  );
}

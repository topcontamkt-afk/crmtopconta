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
  clientesComLimite: number;
  percentualQueUsou: number | null;
  variacao: { clientes: number | null; usos: number | null; valorMovimentado: number | null; lucroJuros: number | null };
  serie: { dia: string; usos: number; clientes: number; valor: number }[];
  cidades: { cidade: string; usos: number; clientes: number; valor: number }[];
}

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
  const maxCidade = Math.max(1, ...d.cidades.map((c) => c.usos));

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
          <Mini label="Clientes que usaram" value={int(t.clientes)} delta={d.variacao.clientes} sub={d.percentualQueUsou !== null ? `${String(d.percentualQueUsou).replace(".", ",")}% da base com limite` : undefined} />
          <Mini label="Usos" value={int(t.usos)} delta={d.variacao.usos} sub={`${int(t.antecipacoes.qtd)} antecipações · ${int(t.comprasAVista.qtd)} compras`} />
          <Mini label="Valor movimentado" value={brl(t.valorMovimentado)} delta={d.variacao.valorMovimentado} sub={`${brl(t.antecipacoes.valor)} em antecipações`} />
          <Mini label="Lucro (juros)" value={brl(t.lucroJuros)} delta={d.variacao.lucroJuros} sub="só antecipações" />
        </div>

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
        <h3>Cidades que mais usaram</h3>
        <p className="pd-card-sub">Número de usos no período, por cidade do cliente.</p>
        {d.cidades.length === 0 ? (
          <p className="pd-hint">Sem uso por cidade neste período.</p>
        ) : (
          d.cidades.map((c) => (
            <div key={c.cidade} className="pd-bar-row">
              <div className="pd-bar-head">
                <span>{c.cidade}</span>
                <span>{int(c.usos)} usos · {int(c.clientes)} clientes</span>
              </div>
              <div className="pd-track"><div className="pd-fill" style={{ width: `${(c.usos / maxCidade) * 100}%`, background: "#ff6907" }} /></div>
              <span className="pd-hint">{brl(c.valor)} movimentados</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

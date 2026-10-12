import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "../api/client";

interface Ponto {
  diaDoCiclo: number;
  usos: number;
  antecipacoes: number;
  diasObservados: number;
  usosPor100: number | null;
}
interface Curva {
  cidadeKey: string | null;
  cidade: string;
  diaAbertura: number | null;
  clientes: number;
  usos: number;
  curva: Ponto[];
  picoDiaDoCiclo: number | null;
  diagnostico: "OK" | "REVISAR" | "POUCOS_DADOS";
  mensagem: string;
}
interface Resp {
  periodo: { de: string; ate: string } | null;
  configurado: boolean;
  cidades: Curva[];
}

const GRID = "#2a3346";
const MUTED = "#9aa4b8";
const dataBR = (iso: string) => iso.split("-").reverse().join("/");

/** Em que dia do ciclo as pessoas usam o cartão (extrato), com diagnóstico da data de abertura cadastrada. */
export default function UsoPorDiaCiclo() {
  const [data, setData] = useState<Resp | null>(null);
  const [sel, setSel] = useState("");
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    api<Resp>("/ciclos/uso-por-dia?dias=90").then(setData).catch((e) => setErro(e.message));
  }, []);

  if (erro) return <p className="error-text">{erro}</p>;
  if (!data) return null;
  if (!data.configurado) return <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Cadastre os ciclos acima para ver o uso por dia do ciclo.</p>;
  if (!data.periodo || data.cidades.length === 0) return <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Importe o extrato de compras para ver o uso por dia do ciclo.</p>;

  const atual = data.cidades.find((c) => (c.cidadeKey ?? "") === sel) ?? data.cidades[0];
  const pontos = atual.curva.filter((p) => p.diasObservados > 0).map((p) => ({ dia: p.diaDoCiclo, valor: p.usosPor100 ?? 0, usos: p.usos, observados: p.diasObservados }));
  const badge = atual.diagnostico === "OK" ? "ok" : atual.diagnostico === "REVISAR" ? "warn" : "";

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>Quando as pessoas usam no ciclo</h3>
      <p style={{ fontSize: 13, color: "var(--text-muted)", maxWidth: 760 }}>
        Antecipações e compras à vista do extrato de {dataBR(data.periodo.de)} a {dataBR(data.periodo.ate)} (até o último dia do extrato), por dia do ciclo.
        O valor é “usos por 100 clientes por dia”, para comparar dias vistos um número diferente de vezes.
      </p>
      <div className="form-row">
        <label>Cidade</label>
        <select value={atual.cidadeKey ?? ""} onChange={(e) => setSel(e.target.value)}>
          {data.cidades.map((c) => (
            <option key={c.cidadeKey ?? "todas"} value={c.cidadeKey ?? ""}>
              {c.cidade}{c.diaAbertura ? ` (abre dia ${c.diaAbertura})` : ""}
            </option>
          ))}
        </select>
      </div>

      <p style={{ fontSize: 13 }}>
        <span className={`badge ${badge}`}>{atual.diagnostico === "OK" ? "Data conferida" : atual.diagnostico === "REVISAR" ? "Revisar data" : "Poucos dados"}</span>{" "}
        {atual.mensagem} <span style={{ color: "var(--text-muted)" }}>({atual.usos} usos, {atual.clientes} clientes com limite)</span>
      </p>

      <div style={{ width: "100%", height: 260 }}>
        <ResponsiveContainer>
          <BarChart data={pontos} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="dia" tick={{ fill: MUTED, fontSize: 12 }} label={{ value: "Dia do ciclo (1 = abertura)", position: "insideBottom", offset: -2, fill: MUTED, fontSize: 12 }} height={40} />
            <YAxis tick={{ fill: MUTED, fontSize: 12 }} />
            <Tooltip
              formatter={((v: unknown, _n: unknown, item: any) => [`${v} por 100 clientes (${item.payload.usos} usos em ${item.payload.observados} dia(s) visto(s))`, "Uso"]) as any}
              labelFormatter={(d) => `Dia ${d} do ciclo`}
              contentStyle={{ background: "#171d2b", border: `1px solid ${GRID}` }}
            />
            <Bar dataKey="valor" radius={[3, 3, 0, 0]}>
              {pontos.map((p) => (
                <Cell key={p.dia} fill={p.dia === atual.picoDiaDoCiclo ? "#35c17a" : "#4f7cff"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

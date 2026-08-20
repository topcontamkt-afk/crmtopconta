import { useEffect, useState } from "react";
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

const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export default function Dashboard() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Summary>("/dashboard/summary").then(setSummary).catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="error-text">{error}</div>;
  if (!summary) return <div>Carregando...</div>;

  return (
    <div>
      <h2>Dashboard</h2>
      <div className="grid-kpi">
        <Kpi label="Total de clientes" value={summary.totalClientes} />
        <Kpi label="Novos (30 dias)" value={summary.novosClientes} />
        <Kpi label="Ativos" value={summary.ativos} />
        <Kpi label="Inativos" value={summary.inativos} />
        <Kpi label="Limite total liberado" value={currency.format(Number(summary.limiteTotalLiberado))} />
        <Kpi label="Valor utilizado" value={currency.format(Number(summary.valorUtilizadoTotal))} />
        <Kpi label="Saldo disponível" value={currency.format(Number(summary.saldoDisponivelTotal))} />
        <Kpi label="Ticket médio" value={currency.format(Number(summary.ticketMedio))} />
        <Kpi label="% clientes no limite" value={`${summary.percentualClientes100}%`} />
        <Kpi label="Clientes sem uso" value={summary.clientesSemUso} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div className="card">
          <h3>Clientes por faixa de utilização</h3>
          <table>
            <tbody>
              {summary.porFaixa.map((f) => (
                <tr key={f.faixa}>
                  <td>{f.label}</td>
                  <td>{f.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h3>Ranking de cidades</h3>
          <table>
            <tbody>
              {summary.ranking_cidades.map((c) => (
                <tr key={c.cidade}>
                  <td>{c.cidade}</td>
                  <td>{c.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p style={{ marginTop: 16, color: "var(--text-muted)", fontSize: 13 }}>
        Última atualização: {summary.ultimaAtualizacao ? new Date(summary.ultimaAtualizacao).toLocaleString("pt-BR") : "—"}
      </p>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card">
      <div className="kpi-value">{value}</div>
      <div className="kpi-label">{label}</div>
    </div>
  );
}

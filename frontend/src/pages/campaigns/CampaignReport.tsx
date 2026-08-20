import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../../api/client";

interface Report {
  campaignId: string;
  audienceCount: number | null;
  porStatus: { status: string; count: number }[];
  conversoes: number;
  taxaConversao: string;
  custoTotal: string;
  janelaAtribuicaoDias: number;
}

export default function CampaignReport() {
  const { id } = useParams();
  const [report, setReport] = useState<Report | null>(null);

  useEffect(() => {
    if (id) api<Report>(`/campaigns/${id}/report`).then(setReport);
  }, [id]);

  if (!report) return <div>Carregando...</div>;

  return (
    <div>
      <h2>Relatório da campanha</h2>
      <div className="grid-kpi">
        <div className="card">
          <div className="kpi-value">{report.audienceCount ?? "—"}</div>
          <div className="kpi-label">Público</div>
        </div>
        <div className="card">
          <div className="kpi-value">{report.conversoes}</div>
          <div className="kpi-label">Conversões (janela {report.janelaAtribuicaoDias}d)</div>
        </div>
        <div className="card">
          <div className="kpi-value">{report.taxaConversao}%</div>
          <div className="kpi-label">Taxa de conversão</div>
        </div>
        <div className="card">
          <div className="kpi-value">R$ {Number(report.custoTotal).toFixed(2)}</div>
          <div className="kpi-label">Custo total</div>
        </div>
      </div>

      <div className="card">
        <h3>Status dos envios</h3>
        <table>
          <thead><tr><th>Status</th><th>Quantidade</th></tr></thead>
          <tbody>
            {report.porStatus.map((s) => (
              <tr key={s.status}><td>{s.status}</td><td>{s.count}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

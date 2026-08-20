import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, downloadFile } from "../../api/client";

interface Report {
  campaignId: string;
  isSandbox: boolean;
  audienceCount: number | null;
  porStatus: { status: string; count: number }[];
  conversoes: number;
  taxaConversao: string;
  custoTotal: number;
  valorGerado: number;
  roi: string | null;
  janelaAtribuicaoDias: number;
  variantBreakdown: { variant: string; enviados: number; conversoes: number; taxaConversao: string }[] | null;
}

export default function CampaignReport() {
  const { id } = useParams();
  const [report, setReport] = useState<Report | null>(null);
  const [phones, setPhones] = useState("");
  const [testResult, setTestResult] = useState<string | null>(null);

  function load() {
    if (id) api<Report>(`/campaigns/${id}/report`).then(setReport);
  }
  useEffect(load, [id]);

  async function sendTest() {
    if (!id) return;
    setTestResult("Enviando...");
    try {
      const resp = await api<{ results: { phone: string; status: string; provider: string }[] }>(
        `/campaigns/${id}/test-send`,
        { method: "POST", body: { phones: phones.split(",").map((p) => p.trim()).filter(Boolean) } }
      );
      setTestResult(resp.results.map((r) => `${r.phone}: ${r.status} (${r.provider})`).join(" · "));
    } catch (e) {
      setTestResult(e instanceof Error ? e.message : "Erro ao enviar teste");
    }
  }

  if (!report) return <div>Carregando...</div>;

  return (
    <div>
      <div className="topbar">
        <h2>Relatório da campanha {report.isSandbox && <span className="badge warn">Sandbox</span>}</h2>
        <button className="btn secondary" onClick={() => id && downloadFile(`/campaigns/${id}/report/export.csv`, `campanha-${id}.csv`)}>
          Exportar CSV
        </button>
      </div>

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
        <div className="card">
          <div className="kpi-value">R$ {Number(report.valorGerado).toFixed(2)}</div>
          <div className="kpi-label">Valor gerado (atribuído)</div>
        </div>
        <div className="card">
          <div className="kpi-value">{report.roi ?? "—"}{report.roi ? "%" : ""}</div>
          <div className="kpi-label">ROI</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
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

        {report.variantBreakdown && (
          <div className="card">
            <h3>A/B testing</h3>
            <table>
              <thead><tr><th>Variante</th><th>Enviados</th><th>Conversões</th><th>Taxa</th></tr></thead>
              <tbody>
                {report.variantBreakdown.map((v) => (
                  <tr key={v.variant}>
                    <td>{v.variant}</td><td>{v.enviados}</td><td>{v.conversoes}</td><td>{v.taxaConversao}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Sandbox / QA — enviar amostra de teste</h3>
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
          Envia a variante A diretamente para os números abaixo (dados de exemplo no lugar dos
          placeholders), sem afetar o público real nem os relatórios.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            style={{ flex: 1 }}
            placeholder="Telefones separados por vírgula, ex: +5511999998888, +5511988887777"
            value={phones}
            onChange={(e) => setPhones(e.target.value)}
          />
          <button className="btn secondary" onClick={sendTest}>Enviar teste</button>
        </div>
        {testResult && <p style={{ marginTop: 8, fontSize: 13 }}>{testResult}</p>}
      </div>
    </div>
  );
}

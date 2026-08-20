import { FormEvent, useState } from "react";
import { api } from "../api/client";

export default function Integrations() {
  const [sheetId, setSheetId] = useState("");
  const [sheetRange, setSheetRange] = useState("A1:Z");
  const [cronSchedule, setCronSchedule] = useState("0 6 * * 1,4");
  const [status, setStatus] = useState<string | null>(null);

  async function saveSheetConnection(e: FormEvent) {
    e.preventDefault();
    setStatus(null);
    try {
      await api("/integrations/sheets", {
        method: "PUT",
        body: {
          sheetId,
          sheetRange,
          cronSchedule,
          columnMapping: {
            id_cliente: "id_cliente",
            nome: "nome",
            telefone: "telefone",
            cpf: "cpf",
            cidade: "cidade",
            data_cadastro: "data_cadastro",
            data_abertura_conta: "data_abertura_conta",
            limite_total: "limite_total",
            valor_utilizado: "valor_utilizado",
            saldo_disponivel: "saldo_disponivel",
            valor_antecipado: "valor_antecipado",
            data_ultima_utilizacao: "data_ultima_utilizacao",
            status_conta: "status_conta",
            origem_cliente: "origem_cliente",
            autorizacao_comunicacao: "autorizacao_comunicacao",
          },
        },
      });
      setStatus("Conexão salva com sucesso.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Erro ao salvar");
    }
  }

  async function syncNow() {
    setStatus("Sincronizando...");
    try {
      const resp = await api<{ addedCount: number; updatedCount: number; errorCount: number }>(
        "/imports/google-sheets",
        { method: "POST", body: { sheetId, range: sheetRange } }
      );
      setStatus(`Sincronizado: ${resp.addedCount} novos, ${resp.updatedCount} atualizados, ${resp.errorCount} erros.`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Erro na sincronização");
    }
  }

  async function exportBiNow() {
    setStatus("Exportando resumo...");
    try {
      const resp = await api<{ exported: boolean; reason?: string }>("/integrations/sheets/export-now", { method: "POST" });
      setStatus(resp.exported ? "Resumo exportado para a aba \"CRM_Export\" da planilha." : `Não foi possível exportar: ${resp.reason}`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Erro ao exportar resumo");
    }
  }

  return (
    <div>
      <h2>Integrações</h2>

      <form className="card" onSubmit={saveSheetConnection} style={{ marginBottom: 16 }}>
        <h3>Google Sheets</h3>
        <div className="form-row">
          <label>ID da planilha</label>
          <input value={sheetId} onChange={(e) => setSheetId(e.target.value)} required />
        </div>
        <div className="form-row">
          <label>Range</label>
          <input value={sheetRange} onChange={(e) => setSheetRange(e.target.value)} />
        </div>
        <div className="form-row">
          <label>Agendamento (cron)</label>
          <input value={cronSchedule} onChange={(e) => setCronSchedule(e.target.value)} />
        </div>
        <button className="btn" type="submit">Salvar conexão</button>{" "}
        <button className="btn secondary" type="button" onClick={syncNow}>Sincronizar agora</button>{" "}
        <button className="btn secondary" type="button" onClick={exportBiNow}>Exportar resumo (BI)</button>
        {status && <p style={{ marginTop: 10 }}>{status}</p>}
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
          "Exportar resumo (BI)" escreve os KPIs do dashboard + últimas campanhas numa aba
          "CRM_Export" dessa mesma planilha — roda automaticamente 1x/dia, e dá pra conectar
          Google Data Studio/Looker Studio direto nela como fonte de dados.
        </p>
      </form>

      <div className="card">
        <h3>WhatsApp Cloud API / SMS</h3>
        <p style={{ color: "var(--text-muted)" }}>
          As credenciais de canal (WhatsApp Cloud API e provedor de SMS) são configuradas por variáveis de
          ambiente no MVP (ver <code>backend/.env.example</code>) ou via <code>PUT /api/integrations/channels</code>{" "}
          (perfil Admin). Nenhuma credencial é exibida na interface.
        </p>
      </div>
    </div>
  );
}

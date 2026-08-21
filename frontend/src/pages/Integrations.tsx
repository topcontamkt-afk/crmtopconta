import { FormEvent, useEffect, useState } from "react";
import { api } from "../api/client";

interface ServiceAccountStatus {
  configured: boolean;
  email?: string;
  error?: string;
}

interface SheetConnection {
  sheetId: string;
  sheetRange: string;
  cronSchedule: string;
}

/**
 * Aceita tanto o link completo do Google Sheets (https://docs.google.com/spreadsheets/d/ID/edit#gid=0)
 * quanto o ID "cru" — extrai o ID em ambos os casos, para o usuário poder simplesmente colar o
 * link da barra de endereço sem precisar recortar manualmente.
 */
function extractSheetId(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : trimmed;
}

export default function Integrations() {
  const [sheetId, setSheetId] = useState("");
  const [sheetRange, setSheetRange] = useState("A1:Z");
  const [cronSchedule, setCronSchedule] = useState("0 6 * * 1,4");
  const [status, setStatus] = useState<string | null>(null);
  const [serviceAccount, setServiceAccount] = useState<ServiceAccountStatus | null>(null);

  useEffect(() => {
    api<ServiceAccountStatus>("/integrations/sheets/service-account").then(setServiceAccount);
    // Bug: a tela nunca recarregava a conexão já salva ao abrir/atualizar a página — o "Salvar
    // conexão" funcionava (fica no banco), mas os campos voltavam ao valor padrão a cada reload,
    // dando a impressão de que o link "sumia" mesmo estando salvo.
    api<SheetConnection | null>("/integrations/sheets").then((conn) => {
      if (!conn) return;
      setSheetId(conn.sheetId);
      setSheetRange(conn.sheetRange);
      setCronSchedule(conn.cronSchedule);
    });
  }, []);

  function handleSheetIdChange(value: string) {
    // Normaliza assim que parece um link (cola completa) — se a pessoa ainda está digitando o
    // ID à mão, não mexe no valor.
    setSheetId(value.includes("docs.google.com") ? extractSheetId(value) : value);
  }

  async function saveSheetConnection(e: FormEvent) {
    e.preventDefault();
    setStatus(null);
    try {
      await api("/integrations/sheets", {
        method: "PUT",
        body: {
          sheetId: extractSheetId(sheetId),
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
        { method: "POST", body: { sheetId: extractSheetId(sheetId), range: sheetRange } }
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

        {serviceAccount && !serviceAccount.configured && (
          <div className="card" style={{ background: "var(--surface-alt)", marginBottom: 12 }}>
            <span className="badge warn">Não configurado</span>
            <p style={{ fontSize: 13, marginBottom: 0 }}>
              A sincronização com Google Sheets ainda não foi habilitada no servidor — falta configurar a
              variável <code>GOOGLE_SERVICE_ACCOUNT_JSON</code> (credencial de uma Service Account do Google
              Cloud com a API do Google Sheets ativada) no projeto do back-end na Vercel. Até lá,
              "Sincronizar agora" vai retornar erro.
            </p>
          </div>
        )}
        {serviceAccount?.configured && (
          <div className="card" style={{ background: "var(--surface-alt)", marginBottom: 12 }}>
            <span className="badge ok">Configurado</span>
            <p style={{ fontSize: 13, marginBottom: 0 }}>
              Antes de sincronizar, compartilhe a planilha (botão "Compartilhar" no Google Sheets) com este
              e-mail, como Editor:
              <br />
              <code>{serviceAccount.email}</code>
            </p>
          </div>
        )}

        <div className="form-row">
          <label>Link ou ID da planilha</label>
          <input
            placeholder="Cole o link completo (https://docs.google.com/spreadsheets/d/...) ou só o ID"
            value={sheetId}
            onChange={(e) => handleSheetIdChange(e.target.value)}
            required
          />
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
          A primeira linha da planilha precisa ter exatamente estes cabeçalhos: id_cliente, nome, telefone,
          cpf, cidade, data_cadastro, data_abertura_conta, limite_total, valor_utilizado, saldo_disponivel,
          valor_antecipado, data_ultima_utilizacao, status_conta, origem_cliente, autorizacao_comunicacao.
        </p>
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

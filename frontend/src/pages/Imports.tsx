import { ChangeEvent, Fragment, useEffect, useState } from "react";
import { api } from "../api/client";
import { parseCsv } from "../utils/csv";
import { autoMapColumns, IMPORT_FIELDS } from "../utils/importFields";

interface Quality {
  totalClientes: number;
  registrosIncompletos: { semCidade: number; semDataCadastro: number; semDataAberturaConta: number };
  importacoesUltimos30Dias: number;
  importacoesComErro: number;
  motivosDeErroMaisComuns: { motivo: string; count: number }[];
}

interface ImportJob {
  id: string;
  source: string;
  status: string;
  totalRows: number;
  addedCount: number;
  updatedCount: number;
  errorCount: number;
  startedAt: string;
  errors: { row: number; motivo: string }[] | null;
}

export default function Imports() {
  const [quality, setQuality] = useState<Quality | null>(null);
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const [fileName, setFileName] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [dataRows, setDataRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [importing, setImporting] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  function load() {
    api<Quality>("/imports/quality").then(setQuality);
    api<ImportJob[]>("/imports").then(setJobs);
  }
  useEffect(load, []);

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadStatus(null);
    setUploadError(null);
    try {
      const text = await file.text();
      const rows = parseCsv(text);
      if (rows.length < 2) {
        setUploadError("O arquivo precisa ter uma linha de cabeçalho e ao menos uma linha de dados.");
        return;
      }
      const [header, ...body] = rows;
      setFileName(file.name);
      setHeaders(header);
      setDataRows(body);
      setMapping(autoMapColumns(header));
    } catch {
      setUploadError("Não consegui ler esse arquivo. Confirme que é um .csv válido.");
    } finally {
      e.target.value = ""; // permite selecionar o mesmo arquivo de novo depois de corrigir algo
    }
  }

  function resetUpload() {
    setFileName(null);
    setHeaders([]);
    setDataRows([]);
    setMapping({});
    setUploadStatus(null);
    setUploadError(null);
  }

  const requiredMissing = IMPORT_FIELDS.filter((f) => f.required && mapping[f.key] === undefined);

  async function handleImport() {
    setImporting(true);
    setUploadStatus(null);
    setUploadError(null);
    try {
      const rows = dataRows.map((row) => {
        const obj: Record<string, string> = {};
        for (const field of IMPORT_FIELDS) {
          const idx = mapping[field.key];
          if (idx !== undefined) obj[field.key] = (row[idx] ?? "").trim();
        }
        return obj;
      });
      const resp = await api<{ addedCount: number; updatedCount: number; errorCount: number }>("/imports/csv", {
        method: "POST",
        body: { rows },
      });
      setUploadStatus(
        `Importado: ${resp.addedCount} novos, ${resp.updatedCount} atualizados, ${resp.errorCount} com erro.` +
          (resp.errorCount > 0 ? " Veja o detalhe no histórico abaixo." : "")
      );
      resetUpload();
      load();
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Erro ao importar planilha");
    } finally {
      setImporting(false);
    }
  }

  return (
    <div>
      <h2>Importações &amp; Qualidade da base</h2>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3>Upload de planilha (.csv)</h3>
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
          Exporte sua planilha de clientes como CSV (Excel/Google Sheets: Arquivo → Salvar como/Fazer
          download → CSV) e selecione o arquivo abaixo. Campos com * são obrigatórios; o resto é
          opcional. Se preferir manter a planilha sempre no Google Sheets com sincronização
          automática, use a tela <strong>Integrações</strong> em vez deste upload.
        </p>
        <input type="file" accept=".csv,text/csv" onChange={handleFile} />
        {uploadError && <p className="error-text" style={{ marginTop: 8 }}>{uploadError}</p>}
        {uploadStatus && <p style={{ marginTop: 8 }}>{uploadStatus}</p>}

        {fileName && (
          <div style={{ marginTop: 16 }}>
            <p style={{ fontSize: 13 }}>
              <strong>{fileName}</strong> — {dataRows.length} linha(s) detectada(s). Confira o
              mapeamento de colunas (ajustei automaticamente o que reconheci pelo cabeçalho):
            </p>
            <table>
              <thead>
                <tr><th>Campo do sistema</th><th>Coluna da planilha</th></tr>
              </thead>
              <tbody>
                {IMPORT_FIELDS.map((field) => (
                  <tr key={field.key}>
                    <td>{field.label}{field.required && " *"}</td>
                    <td>
                      <select
                        value={mapping[field.key] ?? ""}
                        onChange={(e) =>
                          setMapping((m) => {
                            const next = { ...m };
                            if (e.target.value === "") delete next[field.key];
                            else next[field.key] = Number(e.target.value);
                            return next;
                          })
                        }
                      >
                        <option value="">— não usar —</option>
                        {headers.map((h, i) => (
                          <option key={i} value={i}>{h || `Coluna ${i + 1}`}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {dataRows.length > 0 && (
              <div style={{ marginTop: 10, overflowX: "auto" }}>
                <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>Prévia (3 primeiras linhas):</p>
                <table>
                  <thead>
                    <tr>{headers.map((h, i) => <th key={i}>{h || `Coluna ${i + 1}`}</th>)}</tr>
                  </thead>
                  <tbody>
                    {dataRows.slice(0, 3).map((row, i) => (
                      <tr key={i}>{headers.map((_, j) => <td key={j}>{row[j]}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {requiredMissing.length > 0 && (
              <p className="error-text" style={{ marginTop: 10 }}>
                Mapeie as colunas obrigatórias: {requiredMissing.map((f) => f.label).join(", ")}.
              </p>
            )}

            <div style={{ marginTop: 12 }}>
              <button
                className="btn"
                disabled={importing || requiredMissing.length > 0}
                onClick={handleImport}
              >
                {importing ? "Importando..." : `Importar ${dataRows.length} clientes`}
              </button>{" "}
              <button className="btn secondary" onClick={resetUpload} disabled={importing}>Cancelar</button>
            </div>
          </div>
        )}
      </div>

      {quality && (
        <div className="grid-kpi">
          <div className="card"><div className="kpi-value">{quality.totalClientes}</div><div className="kpi-label">Total de clientes</div></div>
          <div className="card"><div className="kpi-value">{quality.registrosIncompletos.semCidade}</div><div className="kpi-label">Sem cidade</div></div>
          <div className="card"><div className="kpi-value">{quality.registrosIncompletos.semDataCadastro}</div><div className="kpi-label">Sem data de cadastro</div></div>
          <div className="card"><div className="kpi-value">{quality.importacoesComErro}</div><div className="kpi-label">Importações c/ erro (30d)</div></div>
        </div>
      )}

      {quality && quality.motivosDeErroMaisComuns.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3>Motivos de erro mais comuns (últimos 30 dias)</h3>
          <table>
            <thead><tr><th>Motivo</th><th>Ocorrências</th></tr></thead>
            <tbody>
              {quality.motivosDeErroMaisComuns.map((m) => (
                <tr key={m.motivo}><td>{m.motivo}</td><td>{m.count}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h3>Histórico de importações</h3>
        <table>
          <thead>
            <tr><th>Data</th><th>Origem</th><th>Status</th><th>Linhas</th><th>Novos</th><th>Atualizados</th><th>Erros</th><th></th></tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <Fragment key={j.id}>
                <tr>
                  <td>{new Date(j.startedAt).toLocaleString("pt-BR")}</td>
                  <td>{j.source}</td>
                  <td>
                    <span className={`badge ${j.status === "CONCLUIDO" ? "ok" : j.status === "FALHOU" ? "danger" : j.errorCount ? "warn" : ""}`}>
                      {j.status}
                    </span>
                  </td>
                  <td>{j.totalRows}</td>
                  <td>{j.addedCount}</td>
                  <td>{j.updatedCount}</td>
                  <td>{j.errorCount}</td>
                  <td>
                    {j.errorCount > 0 && (
                      <button className="btn secondary" onClick={() => setExpanded(expanded === j.id ? null : j.id)}>
                        {expanded === j.id ? "Ocultar erros" : "Ver erros"}
                      </button>
                    )}
                  </td>
                </tr>
                {expanded === j.id && j.errors && (
                  <tr>
                    <td colSpan={8}>
                      <div style={{ padding: 8, background: "var(--surface-alt)", borderRadius: 6 }}>
                        <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 0 }}>
                          Corrija a planilha de origem para as linhas abaixo e rode a sincronização
                          novamente, ou use <code>POST /api/imports/{j.id}/fix-errors</code> para
                          reenviar apenas as linhas corrigidas.
                        </p>
                        <table>
                          <thead><tr><th>Linha</th><th>Motivo</th></tr></thead>
                          <tbody>
                            {j.errors.slice(0, 50).map((e, i) => (
                              <tr key={i}><td>{e.row}</td><td>{e.motivo}</td></tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {jobs.length === 0 && (
              <tr><td colSpan={8} style={{ color: "var(--text-muted)" }}>Nenhuma importação registrada ainda</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

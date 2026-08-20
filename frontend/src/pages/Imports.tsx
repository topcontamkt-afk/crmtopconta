import { Fragment, useEffect, useState } from "react";
import { api } from "../api/client";

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

  function load() {
    api<Quality>("/imports/quality").then(setQuality);
    api<ImportJob[]>("/imports").then(setJobs);
  }
  useEffect(load, []);

  return (
    <div>
      <h2>Importações &amp; Qualidade da base</h2>

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

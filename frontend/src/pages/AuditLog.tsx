import { useEffect, useState } from "react";
import { api } from "../api/client";

interface LogEntry {
  id: string;
  action: string;
  target: string | null;
  targetId: string | null;
  createdAt: string;
  user: { name: string; email: string } | null;
}

export default function AuditLog() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<LogEntry[]>("/audit-logs").then(setLogs).catch((e) => setError(e.message));
  }, []);

  return (
    <div>
      <h2>Auditoria</h2>
      {error && <div className="error-text">{error} (requer perfil Admin ou Analista)</div>}
      <div className="card">
        <table>
          <thead><tr><th>Data</th><th>Usuário</th><th>Ação</th><th>Alvo</th></tr></thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id}>
                <td>{new Date(l.createdAt).toLocaleString("pt-BR")}</td>
                <td>{l.user?.name || "sistema"}</td>
                <td>{l.action}</td>
                <td>{l.target} {l.targetId ? `(${l.targetId.slice(0, 8)}…)` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

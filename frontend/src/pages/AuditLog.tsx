import { useEffect, useState } from "react";
import { api } from "../api/client";

interface LogEntry {
  id: string;
  action: string;
  target: string | null;
  targetId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
  user: { name: string; email: string } | null;
}

// LGPD 05-03: tentativas de acesso indevido (mesma lista de ACOES_ACESSO_INDEVIDO no backend).
const ROTULO_ACAO: Record<string, string> = {
  LOGIN_FALHA: "Login falho",
  LOGIN_BLOQUEADO: "Conta bloqueada (excesso de tentativas)",
  "2FA_FALHA": "Código 2FA inválido",
  ACESSO_NEGADO: "Acesso negado (papel)",
  IMPORT_GOOGLE_SHEETS_NEGADO: "Planilha não autorizada",
};

/** Resumo dos detalhes de uma tentativa (o backend já grava o e-mail mascarado e nunca senha/token). */
function resumoTentativa(d: LogEntry["details"]): string {
  if (!d) return "";
  const partes = [d.motivo, d.email, d.codigo, d.ip].filter((v) => typeof v === "string" && v);
  return partes.join(" · ");
}

export default function AuditLog() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [grupo, setGrupo] = useState<"" | "acesso_indevido">("");

  useEffect(() => {
    setError(null);
    api<LogEntry[]>(`/audit-logs${grupo ? `?grupo=${grupo}` : ""}`).then(setLogs).catch((e) => setError(e.message));
  }, [grupo]);

  return (
    <div>
      <h2>Auditoria</h2>
      <div style={{ marginBottom: 12 }}>
        <select aria-label="Filtrar ações" value={grupo} onChange={(e) => setGrupo(e.target.value as typeof grupo)}>
          <option value="">Todas as ações</option>
          <option value="acesso_indevido">Tentativas de acesso indevido</option>
        </select>
      </div>
      {error && <div className="error-text">{error} (requer perfil Admin ou Analista)</div>}
      <div className="card">
        <table>
          <thead><tr><th>Data</th><th>Usuário</th><th>Ação</th><th>Alvo</th><th>Detalhes</th></tr></thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id}>
                <td>{new Date(l.createdAt).toLocaleString("pt-BR")}</td>
                <td>{l.user?.name || "sistema"}</td>
                <td>{ROTULO_ACAO[l.action] || l.action}</td>
                <td>{l.target} {l.targetId ? `(${l.targetId.slice(0, 8)}…)` : ""}</td>
                <td>{ROTULO_ACAO[l.action] ? resumoTentativa(l.details) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

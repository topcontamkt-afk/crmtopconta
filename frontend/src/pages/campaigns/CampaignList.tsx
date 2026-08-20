import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";

interface Campaign {
  id: string;
  name: string;
  channel: string;
  status: string;
  audienceCount: number | null;
  scheduledAt: string | null;
  createdAt: string;
}

export default function CampaignList() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);

  function load() {
    api<Campaign[]>("/campaigns").then(setCampaigns);
  }

  useEffect(load, []);

  async function schedule(id: string) {
    await api(`/campaigns/${id}/schedule`, { method: "POST" });
    load();
  }

  async function dispatch(id: string) {
    await api(`/campaigns/${id}/dispatch`, { method: "POST", body: { limit: 50 } });
    load();
  }

  return (
    <div>
      <div className="topbar">
        <h2>Campanhas</h2>
        <Link className="btn" to="/campaigns/new">+ Nova campanha</Link>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr><th>Nome</th><th>Canal</th><th>Status</th><th>Público</th><th>Ações</th></tr>
          </thead>
          <tbody>
            {campaigns.map((c) => (
              <tr key={c.id}>
                <td><Link to={`/campaigns/${c.id}/report`}>{c.name}</Link></td>
                <td>{c.channel}</td>
                <td><span className="badge">{c.status}</span></td>
                <td>{c.audienceCount ?? "—"}</td>
                <td>
                  {c.status === "RASCUNHO" && (
                    <button className="btn secondary" onClick={() => schedule(c.id)}>Agendar/Enfileirar</button>
                  )}{" "}
                  {(c.status === "AGENDADA" || c.status === "EM_EXECUCAO") && (
                    <button className="btn secondary" onClick={() => dispatch(c.id)}>Disparar lote</button>
                  )}
                </td>
              </tr>
            ))}
            {campaigns.length === 0 && (
              <tr><td colSpan={5} style={{ color: "var(--text-muted)" }}>Nenhuma campanha criada ainda</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

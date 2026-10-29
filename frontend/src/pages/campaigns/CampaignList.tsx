import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../api/client";

interface Contagem {
  fila: number;
  enviadas: number;
  falhas: number;
  bloqueadas: number;
  total: number;
}

interface Campaign {
  id: string;
  name: string;
  channel: string;
  status: string;
  audienceCount: number | null;
  manual?: boolean;
  scheduledAt: string | null;
  createdAt: string;
  emDisparo?: boolean;
  contagem?: Contagem | null;
}

export default function CampaignList() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [aviso, setAviso] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);
  const navigate = useNavigate();

  const load = useCallback(() => api<Campaign[]>("/campaigns").then(setCampaigns), []);
  useEffect(() => void load(), [load]);

  // Disparo em andamento em outra aba/usuário: a lista se atualiza sozinha até terminar
  const haDisparoRemoto = campaigns.some((c) => c.emDisparo);
  useEffect(() => {
    if (!haDisparoRemoto) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [haDisparoRemoto, load]);

  async function schedule(id: string) {
    await api(`/campaigns/${id}/schedule`, { method: "POST" });
    load();
  }

  async function pausar(c: Campaign) {
    if (!window.confirm(`Pausar “${c.name}”? O que está na fila fica parado até você retomar.`)) return;
    await api(`/campaigns/${c.id}/pause`, { method: "POST" }).catch((e) => setAviso({ tipo: "erro", texto: textoErro(e) }));
    load();
  }

  async function retomar(c: Campaign) {
    await api(`/campaigns/${c.id}/resume`, { method: "POST" }).catch((e) => setAviso({ tipo: "erro", texto: textoErro(e) }));
    load();
  }

  /** Confirma e abre o relatório da campanha, que roda o envio e mostra o funil ao vivo. */
  function disparar(c: Campaign) {
    const fila = c.contagem?.fila ?? c.audienceCount ?? 0;
    if (!window.confirm(`Enviar agora a campanha “${c.name}” para ${fila} contato(s)? Depois de enviada não dá para repetir o envio.`)) return;
    navigate(`/campaigns/${c.id}/report?enviar=1`);
  }

  return (
    <div>
      <div className="topbar">
        <h2>Campanhas</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <Link className="btn secondary" to="/campaigns/new?publico=planilha">Campanha por planilha</Link>
          <Link className="btn" to="/campaigns/new">+ Nova campanha</Link>
        </div>
      </div>

      {aviso && (
        <div className="card" style={{ marginBottom: 12, borderLeft: `4px solid ${aviso.tipo === "ok" ? "var(--success)" : "var(--danger)"}`, fontSize: 13 }}>
          {aviso.texto}
        </div>
      )}

      <div className="card">
        <table>
          <thead>
            <tr><th>Nome</th><th>Canal</th><th>Status</th><th>Público</th><th>Envio</th><th>Ações</th></tr>
          </thead>
          <tbody>
            {campaigns.map((c) => (
              <tr key={c.id}>
                <td><Link to={`/campaigns/${c.id}/report`}>{c.name}</Link>{c.manual && <> <span className="badge">planilha</span></>}</td>
                <td>{c.channel}</td>
                <td><span className="badge">{c.status}</span></td>
                <td>{c.audienceCount ?? "—"}</td>
                <td style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  {c.contagem ? (
                    <>
                      {c.contagem.enviadas} enviadas · {c.contagem.fila} na fila
                      {c.contagem.falhas > 0 && <> · {c.contagem.falhas} falhas</>}
                      {c.contagem.bloqueadas > 0 && <> · {c.contagem.bloqueadas} bloqueadas</>}
                    </>
                  ) : "—"}
                </td>
                <td>
                  <Acoes
                    c={c}
                    onAgendar={() => schedule(c.id)}
                    onDisparar={() => disparar(c)}
                    onPausar={() => pausar(c)}
                    onRetomar={() => retomar(c)}
                  />
                </td>
              </tr>
            ))}
            {campaigns.length === 0 && (
              <tr><td colSpan={6} style={{ color: "var(--text-muted)" }}>Nenhuma campanha criada ainda</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Acoes({ c, onAgendar, onDisparar, onPausar, onRetomar }: { c: Campaign; onAgendar: () => void; onDisparar: () => void; onPausar: () => void; onRetomar: () => void }) {
  if (c.status === "RASCUNHO") return <button className="btn secondary" onClick={onAgendar}>Agendar/Enfileirar</button>;
  if (c.status === "PAUSADA") return <button className="btn secondary" onClick={onRetomar}>Retomar</button>;

  if (c.emDisparo) return <Link className="btn secondary" to={`/campaigns/${c.id}/report`}>Enviando… acompanhar</Link>;

  const enviadas = c.contagem?.enviadas ?? 0;
  const fila = c.contagem?.fila ?? 0;
  if (c.status === "CONCLUIDA" || (c.contagem && fila === 0 && c.contagem.total > 0)) {
    return <button className="btn secondary" disabled title="Esta campanha já foi enviada">Enviado ✓ {enviadas}</button>;
  }
  if (c.status === "AGENDADA" || c.status === "EM_EXECUCAO") {
    return (
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button className="btn secondary" onClick={onDisparar}>{enviadas > 0 ? `Continuar envio (restam ${fila})` : "Disparar lote"}</button>
        <button className="btn secondary" onClick={onPausar}>Pausar</button>
      </div>
    );
  }
  return null;
}

function textoErro(e: unknown): string {
  const m = String((e as Error)?.message ?? "Erro inesperado");
  try {
    const v = JSON.parse(m);
    return typeof v === "string" ? v : m;
  } catch {
    return m;
  }
}

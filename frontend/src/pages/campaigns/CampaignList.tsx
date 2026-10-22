import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../../api/client";

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

interface Progresso {
  enviadas: number;
  total: number;
  fase: string;
}

const LOTE = 25;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function CampaignList() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [progresso, setProgresso] = useState<Record<string, Progresso>>({});
  const [aviso, setAviso] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);
  // ids com disparo em curso NESTA tela: o botão fica desabilitado já no clique (clique duplo não dispara duas vezes)
  const emCurso = useRef<Set<string>>(new Set());

  const load = useCallback(() => api<Campaign[]>("/campaigns").then(setCampaigns), []);
  useEffect(() => void load(), [load]);

  // Disparo em andamento em outra aba/usuário: a lista se atualiza sozinha até terminar
  const haDisparoRemoto = campaigns.some((c) => c.emDisparo && !emCurso.current.has(c.id));
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

  async function disparar(c: Campaign) {
    if (emCurso.current.has(c.id)) return;
    const fila = c.contagem?.fila ?? c.audienceCount ?? 0;
    if (!window.confirm(`Enviar agora a campanha “${c.name}” para ${fila} contato(s)? Depois de enviada não dá para repetir o envio.`)) return;
    emCurso.current.add(c.id);
    const total = fila;
    const marcar = (enviadas: number, fase: string) => setProgresso((p) => ({ ...p, [c.id]: { enviadas, total, fase } }));
    marcar(0, "Enviando…");
    setAviso(null);
    let enviadas = 0;
    let semProgresso = 0;
    let concluida = false;
    try {
      for (let guarda = 0; guarda < 2000; guarda++) {
        let r: { processed: number; remaining: number; throttled?: boolean; bloqueado?: string; parcial?: string | null };
        try {
          r = await api(`/campaigns/${c.id}/dispatch`, { method: "POST", body: { limit: LOTE } });
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) {
            // outro disparo desta campanha em andamento: espera, sem enviar nada
            marcar(enviadas, "Outro disparo em andamento… aguardando");
            await sleep(4000);
            continue;
          }
          throw e;
        }
        if (r.bloqueado) {
          setAviso({ tipo: "erro", texto: r.bloqueado });
          break;
        }
        enviadas = Math.max(0, total - r.remaining);
        marcar(enviadas, r.throttled ? "Aguardando o limite de envios por minuto…" : "Enviando…");
        if (r.remaining === 0) {
          concluida = true;
          break;
        }
        if (r.throttled) {
          await sleep(8000);
        } else if (r.processed === 0 && !r.parcial) {
          // nada saiu e nada explica: não insiste para sempre
          if (++semProgresso >= 5) {
            setAviso({ tipo: "erro", texto: "O envio parou sem avançar. Veja o relatório da campanha e tente de novo." });
            break;
          }
          await sleep(3000);
        } else {
          semProgresso = 0;
          if (r.parcial) await sleep(500);
        }
      }
      if (concluida) setAviso({ tipo: "ok", texto: `Envio concluído: “${c.name}”.` });
    } catch (e) {
      setAviso({ tipo: "erro", texto: `O envio parou: ${textoErro(e)}` });
    } finally {
      emCurso.current.delete(c.id);
      setProgresso((p) => {
        const { [c.id]: _feito, ...resto } = p;
        return resto;
      });
      load();
    }
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
                    progresso={progresso[c.id]}
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

function Acoes({ c, progresso, onAgendar, onDisparar, onPausar, onRetomar }: { c: Campaign; progresso?: Progresso; onAgendar: () => void; onDisparar: () => void; onPausar: () => void; onRetomar: () => void }) {
  if (c.status === "RASCUNHO") return <button className="btn secondary" onClick={onAgendar}>Agendar/Enfileirar</button>;
  if (c.status === "PAUSADA") return <button className="btn secondary" onClick={onRetomar}>Retomar</button>;

  if (progresso) {
    const pct = progresso.total > 0 ? Math.min(100, Math.round((progresso.enviadas / progresso.total) * 100)) : 0;
    return (
      <div style={{ minWidth: 180 }}>
        <button className="btn secondary" disabled>Enviando… {progresso.enviadas}/{progresso.total}</button>
        <div style={{ height: 4, background: "var(--border)", borderRadius: 2, marginTop: 6 }}>
          <div style={{ width: `${pct}%`, height: 4, background: "var(--success)", borderRadius: 2 }} />
        </div>
        <div className="pd-hint">{progresso.fase} Mantenha esta tela aberta.</div>
      </div>
    );
  }
  if (c.emDisparo) return <button className="btn secondary" disabled>Enviando em outra aba…</button>;

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

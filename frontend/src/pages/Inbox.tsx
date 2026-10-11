import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api, getToken } from "../api/client";
import { useAuth } from "../context/AuthContext";

interface Status {
  account: { phoneNumberId: string; wabaId: string | null; displayName: string | null; displayPhone: string | null; active: boolean } | null;
  webhookUrl: string;
  config: { appSecret: boolean; verifyToken: boolean; accessToken: boolean };
}
interface Conversa {
  id: string;
  nome: string;
  cidade: string | null;
  clienteId: string | null;
  telefone: string;
  preview: string | null;
  ultimaMensagemEm: string;
  naoLidas: number;
  janelaAberta: boolean;
  janelaAte: string | null;
}
interface Mensagem {
  id: string;
  direcao: "ENTRADA" | "SAIDA";
  tipo: string;
  texto: string | null;
  midia: { mime: string | null; nomeArquivo: string | null } | null;
  status: string | null;
  erro: string | null;
  em: string;
}
interface Thread {
  conversa: { id: string; nome: string; telefone: string; janelaAberta: boolean; janelaAte: string | null; naoLidas: number };
  cliente: { nome: string; cidade: string | null; perfil: string | null; limiteTotal: number; saldoDisponivel: number; faixaUso: string; podeReceberCampanha: boolean; optOutEm: string | null } | null;
  mensagens: Mensagem[];
}

const POLL_MS = 5000;
const brl = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const hora = (iso: string) => {
  const d = new Date(iso);
  const hoje = new Date();
  return d.toDateString() === hoje.toDateString() ? d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
};
const urlsMidia = new Map<string, string>(); // mensagem -> URL local do arquivo (vale na sessão)

/** Busca o arquivo com o token (um <img src> não consegue enviar Authorization) e devolve uma URL local. */
async function carregarMidia(id: string): Promise<string> {
  const pronto = urlsMidia.get(id);
  if (pronto) return pronto;
  const token = getToken();
  const r = await fetch(`/api/inbox/media/${id}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(typeof j.error === "string" ? j.error : "Mídia indisponível.");
  }
  const url = URL.createObjectURL(await r.blob());
  urlsMidia.set(id, url);
  return url;
}

/** Imagem, figurinha, áudio, vídeo e documento (PDF abre em nova aba). */
function Midia({ m, onAbrirImagem }: { m: Mensagem; onAbrirImagem: (url: string) => void }) {
  const [url, setUrl] = useState<string | null>(urlsMidia.get(m.id) ?? null);
  const [erro, setErro] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const automatica = ["image", "sticker", "audio", "video"].includes(m.tipo);

  const baixar = useCallback(() => {
    setBusy(true);
    setErro(null);
    return carregarMidia(m.id)
      .then(setUrl)
      .catch((e) => setErro(e.message))
      .finally(() => setBusy(false));
  }, [m.id]);

  useEffect(() => {
    if (automatica && !url && !erro) baixar();
  }, [automatica, url, erro, baixar]);

  if (erro) {
    return (
      <div className="media">
        {MIDIA_ROTULO[m.tipo] ?? "Anexo"}: {erro}{" "}
        <button type="button" className="btn secondary" style={{ padding: "2px 8px", fontSize: 11 }} onClick={baixar}>Tentar de novo</button>
      </div>
    );
  }
  if (!url) {
    return automatica ? (
      <div className="media">{busy ? "Carregando…" : MIDIA_ROTULO[m.tipo]}</div>
    ) : (
      <div className="media">
        {MIDIA_ROTULO[m.tipo] ?? "Anexo"}{m.midia?.nomeArquivo ? ` · ${m.midia.nomeArquivo}` : ""}
        <button type="button" className="btn secondary" style={{ padding: "2px 8px", fontSize: 11 }} disabled={busy} onClick={baixar}>{busy ? "Carregando…" : "Carregar"}</button>
      </div>
    );
  }
  if (m.tipo === "image" || m.tipo === "sticker") {
    return <img className={m.tipo === "sticker" ? "wa-sticker" : "wa-img"} src={url} alt={m.texto ?? "Imagem recebida"} onClick={() => onAbrirImagem(url)} />;
  }
  if (m.tipo === "audio") return <audio controls preload="metadata" src={url} style={{ maxWidth: "100%" }} />;
  if (m.tipo === "video") return <video controls preload="metadata" src={url} style={{ maxWidth: "100%", borderRadius: 8 }} />;
  const nome = m.midia?.nomeArquivo ?? "documento";
  return (
    <div className="media" style={{ flexWrap: "wrap" }}>
      📄 {nome}
      <a className="btn secondary" style={{ padding: "2px 8px", fontSize: 11, textDecoration: "none" }} href={url} target="_blank" rel="noreferrer">Abrir</a>
      <a className="btn secondary" style={{ padding: "2px 8px", fontSize: 11, textDecoration: "none" }} href={url} download={nome}>Baixar</a>
    </div>
  );
}

const MIDIA_ROTULO: Record<string, string> = { image: "📷 Imagem", audio: "🎤 Áudio", video: "🎬 Vídeo", document: "📄 Documento", sticker: "Figurinha" };

function tempoRestante(iso: string | null): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "";
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}` : `${m} min`;
}

/** Conexão com a Meta: guia o ADMIN a ligar o número e mostra o que falta configurar. */
function Conectar({ status, onSaved, isAdmin }: { status: Status; onSaved: () => void; isAdmin: boolean }) {
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [wabaId, setWabaId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function salvar(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErro(null);
    try {
      await api("/inbox/account", { method: "PUT", body: { phoneNumberId: phoneNumberId.trim(), wabaId: wabaId.trim(), displayName: displayName.trim() || undefined } });
      onSaved();
    } catch (err: any) {
      setErro(err.message ?? "Não foi possível salvar.");
    } finally {
      setBusy(false);
    }
  }
  const ok = (v: boolean) => (v ? "✅" : "⬜");

  return (
    <div className="card" style={{ maxWidth: 760 }}>
      <h3>Conectar o WhatsApp (Meta Cloud API)</h3>
      <p className="seg-hint">
        Quando um cliente responde no WhatsApp, a Meta avisa este sistema pelo <strong>webhook</strong> e a conversa aparece aqui. Siga o roteiro da Fase 0 e depois informe o número abaixo.
      </p>
      <div className="seg-section">
        <strong style={{ fontSize: 13 }}>Checklist do ambiente</strong>
        <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13, lineHeight: 1.8 }}>
          <li>{ok(!!status.account)} Número conectado a esta conta</li>
          <li>{ok(status.config.appSecret)} <code>WHATSAPP_APP_SECRET</code> na Vercel (obrigatório para receber mensagens)</li>
          <li>{ok(status.config.verifyToken)} <code>WHATSAPP_WEBHOOK_VERIFY_TOKEN</code> na Vercel</li>
          <li>{ok(status.config.accessToken)} <code>WHATSAPP_ACCESS_TOKEN</code> na Vercel (necessário para responder, Fase 3)</li>
        </ul>
      </div>
      <div className="seg-section">
        <strong style={{ fontSize: 13 }}>No painel da Meta (WhatsApp → Configuração → Webhook)</strong>
        <p className="seg-hint" style={{ marginBottom: 6 }}>URL de retorno (copie e cole):</p>
        <code style={{ display: "block", padding: 8, background: "var(--bg)", borderRadius: 8, wordBreak: "break-all" }}>{status.webhookUrl}</code>
        <p className="seg-hint" style={{ marginTop: 8 }}>Token de verificação: o mesmo valor de <code>WHATSAPP_WEBHOOK_VERIFY_TOKEN</code>. Assine o campo <strong>messages</strong>.</p>
      </div>
      {isAdmin ? (
        <form onSubmit={salvar}>
          <div className="seg-row">
            <div className="form-row">
              <label>Phone Number ID (da Meta)</label>
              <input required value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} placeholder="Ex: 105512345678901" />
            </div>
            <div className="form-row">
              <label>WABA ID (opcional)</label>
              <input value={wabaId} onChange={(e) => setWabaId(e.target.value)} placeholder="ID da conta do WhatsApp Business" />
            </div>
            <div className="form-row">
              <label>Nome de exibição (opcional)</label>
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Como o número aparece" />
            </div>
          </div>
          {erro && <div className="error-text">{erro}</div>}
          <button className="btn" disabled={busy}>{status.account ? "Atualizar número" : "Conectar número"}</button>
        </form>
      ) : (
        <p className="seg-hint">Peça a um administrador para conectar o número.</p>
      )}
    </div>
  );
}

export default function Inbox() {
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  const [status, setStatus] = useState<Status | null>(null);
  const [filtro, setFiltro] = useState<"todas" | "nao_lidas" | "janela_aberta" | "sem_cliente">("todas");
  const [busca, setBusca] = useState("");
  const [conversas, setConversas] = useState<Conversa[]>([]);
  const [naoLidas, setNaoLidas] = useState(0);
  const [sel, setSel] = useState<string | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [mostrarConexao, setMostrarConexao] = useState(false);
  const [imagemAberta, setImagemAberta] = useState<string | null>(null);
  const fim = useRef<HTMLDivElement>(null);
  const ultimoTotal = useRef(0);

  const carregarStatus = useCallback(() => api<Status>("/inbox/status").then(setStatus).catch((e) => setErro(e.message)), []);
  useEffect(() => void carregarStatus(), [carregarStatus]);

  const carregarLista = useCallback(() => {
    const qs = new URLSearchParams({ filtro });
    if (busca.trim()) qs.set("busca", busca.trim());
    return api<{ conversas: Conversa[]; naoLidas: number }>(`/inbox/conversations?${qs}`)
      .then((r) => {
        setConversas(r.conversas);
        setNaoLidas(r.naoLidas);
        setErro(null);
      })
      .catch((e) => setErro(e.message));
  }, [filtro, busca]);

  const carregarThread = useCallback(() => {
    if (!sel) return Promise.resolve();
    return api<Thread>(`/inbox/conversations/${sel}/messages`).then(setThread).catch((e) => setErro(e.message));
  }, [sel]);

  // atualização automática enquanto a aba está visível (a Vercel não mantém conexão aberta)
  useEffect(() => {
    if (!status?.account) return;
    carregarLista();
    const t = setInterval(() => document.visibilityState === "visible" && carregarLista(), POLL_MS);
    return () => clearInterval(t);
  }, [status?.account, carregarLista]);

  useEffect(() => {
    setThread(null);
    ultimoTotal.current = 0;
    if (!sel) return;
    carregarThread();
    api(`/inbox/conversations/${sel}/read`, { method: "POST" }).then(carregarLista).catch(() => {});
    const t = setInterval(() => {
      if (document.visibilityState === "visible") {
        carregarThread();
        api(`/inbox/conversations/${sel}/read`, { method: "POST" }).catch(() => {});
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [sel]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (thread && thread.mensagens.length !== ultimoTotal.current) {
      ultimoTotal.current = thread.mensagens.length;
      fim.current?.scrollIntoView({ block: "end" });
    }
  }, [thread]);

  if (!status) return <div>{erro ? <div className="error-text">{erro}</div> : "Carregando…"}</div>;

  if (!status.account || mostrarConexao) {
    return (
      <div>
        <h2>Inbox do WhatsApp</h2>
        <Conectar status={status} isAdmin={isAdmin} onSaved={() => { setMostrarConexao(false); carregarStatus(); }} />
        {status.account && <button className="btn secondary" style={{ marginTop: 12 }} onClick={() => setMostrarConexao(false)}>Voltar para as conversas</button>}
      </div>
    );
  }

  const restante = thread ? tempoRestante(thread.conversa.janelaAte) : "";

  return (
    <div>
      <div className="pd-card-head" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Inbox do WhatsApp {naoLidas > 0 && <span className="inbox-badge">{naoLidas}</span>}</h2>
        <button className="btn secondary" onClick={() => setMostrarConexao(true)}>Conexão com a Meta</button>
      </div>
      {!status.config.appSecret && (
        <div className="card" style={{ borderLeft: "4px solid var(--warning)", marginBottom: 10, fontSize: 13 }}>
          <code>WHATSAPP_APP_SECRET</code> não está configurado: as mensagens dos clientes são ignoradas até você configurá-lo na Vercel.
        </div>
      )}
      {erro && <div className="error-text">{erro}</div>}

      {imagemAberta && (
        <div className="wa-lightbox" onClick={() => setImagemAberta(null)} role="dialog" aria-label="Imagem ampliada">
          <img src={imagemAberta} alt="Imagem ampliada" />
        </div>
      )}

      <div className="inbox">
        <div className="inbox-list">
          <div className="inbox-list-head">
            <input placeholder="Buscar por nome ou telefone" value={busca} onChange={(e) => setBusca(e.target.value)} />
            <div className="chip-group">
              {([["todas", "Todas"], ["nao_lidas", "Não lidas"], ["janela_aberta", "Janela aberta"], ["sem_cliente", "Sem cadastro"]] as const).map(([v, l]) => (
                <label key={v} className="chip">
                  <input type="radio" name="filtro" checked={filtro === v} onChange={() => setFiltro(v)} />
                  <span>{l}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="inbox-items">
            {conversas.length === 0 && (
              <div className="inbox-empty">
                Nenhuma conversa ainda. Quando um cliente escrever para o número conectado, ela aparece aqui sozinha.
              </div>
            )}
            {conversas.map((c) => (
              <button key={c.id} className={`inbox-item${sel === c.id ? " active" : ""}`} onClick={() => setSel(c.id)}>
                <div className="top">
                  <span>{c.nome}</span>
                  <time>{hora(c.ultimaMensagemEm)}</time>
                </div>
                <div className="prev">
                  <span>{c.preview ?? ""}</span>
                  {c.naoLidas > 0 && <span className="inbox-badge">{c.naoLidas}</span>}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="inbox-thread">
          {!sel || !thread ? (
            <div className="inbox-empty">{sel ? "Carregando…" : "Selecione uma conversa para ver as mensagens."}</div>
          ) : (
            <>
              <div className="inbox-thread-head">
                <div>
                  <strong>{thread.conversa.nome}</strong>
                  <div className="pd-hint">
                    {thread.conversa.telefone}
                    {thread.cliente?.cidade ? ` · ${thread.cliente.cidade}` : ""}
                    {thread.cliente?.perfil ? ` · ${thread.cliente.perfil}` : ""}
                    {thread.cliente ? ` · limite ${brl(thread.cliente.limiteTotal)} · saldo ${brl(thread.cliente.saldoDisponivel)}` : " · não está na base de clientes"}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {thread.cliente?.optOutEm && <span className="inbox-chip closed">Pediu descadastro</span>}
                  <span className={`inbox-chip ${thread.conversa.janelaAberta ? "open" : "closed"}`}>
                    {thread.conversa.janelaAberta ? `Janela de 24h aberta · ${restante}` : "Janela de 24h fechada · só template"}
                  </span>
                </div>
              </div>
              <div className="inbox-msgs">
                {thread.mensagens.map((m) => (
                  <div key={m.id} className={`bubble ${m.direcao === "ENTRADA" ? "in" : "out"}`}>
                    {m.midia && <Midia m={m} onAbrirImagem={setImagemAberta} />}
                    {m.texto && <div>{m.texto}</div>}
                    {!m.texto && !m.midia && <em style={{ color: "var(--text-muted)" }}>[{m.tipo}]</em>}
                    <time>{new Date(m.em).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</time>
                  </div>
                ))}
                <div ref={fim} />
              </div>
              <div className="inbox-composer">Somente leitura por enquanto. O envio de respostas e de templates chega nas próximas fases.</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

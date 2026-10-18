import { FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api, getToken } from "../api/client";
import { useAuth } from "../context/AuthContext";

interface Status {
  provider?: "META" | "ZAPI";
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
  canal?: "META" | "ZAPI";
}
interface Mensagem {
  id: string;
  direcao: "ENTRADA" | "SAIDA";
  tipo: string;
  texto: string | null;
  midia: { mime: string | null; nomeArquivo: string | null } | null;
  status: string | null;
  erro: string | null;
  automatica?: boolean;
  em: string;
}
interface Thread {
  conversa: { id: string; nome: string; telefone: string; canal?: "META" | "ZAPI"; janelaAberta: boolean; janelaAte: string | null; naoLidas: number };
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

/** ✓ enviado, ✓✓ entregue, ✓✓ azul lido, ⚠ falhou */
function Entrega({ status }: { status: string | null }) {
  if (status === "failed") return <span style={{ color: "var(--danger)" }}> ⚠</span>;
  if (status === "read") return <span style={{ color: "#53bdeb" }}> ✓✓</span>;
  if (status === "delivered") return <span> ✓✓</span>;
  return <span> ✓</span>;
}

const MAX_ARQUIVO = 3 * 1024 * 1024;
const ACEITOS = "image/jpeg,image/png,application/pdf,audio/ogg,audio/mpeg,audio/mp4,audio/aac,audio/amr,video/mp4";

/** O api() devolve o texto do erro já em JSON ("\"mensagem\""): tira as aspas. */
function textoDoErro(e: any): string {
  const m = String(e?.message ?? "Erro inesperado");
  try {
    const v = JSON.parse(m);
    return typeof v === "string" ? v : m;
  } catch {
    return m;
  }
}

function lerBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("Não foi possível ler o arquivo."));
    r.readAsDataURL(file);
  });
}

interface TemplateOpcao {
  id: string;
  nome: string;
  categoria: string | null;
  texto: string;
  botoes: string[];
}

/** Janela de 24h fechada: o único caminho é um template aprovado pela Meta. */
function TemplatePicker({ conversaId, onEnviada }: { conversaId: string; onEnviada: () => void }) {
  const [opcoes, setOpcoes] = useState<TemplateOpcao[] | null>(null);
  const [sel, setSel] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    setOpcoes(null);
    setSel("");
    setErro(null);
    api<TemplateOpcao[]>(`/inbox/conversations/${conversaId}/templates`).then(setOpcoes).catch((e) => setErro(textoDoErro(e)));
  }, [conversaId]);

  const atual = opcoes?.find((o) => o.id === sel);

  async function enviar() {
    if (!atual || enviando) return;
    setEnviando(true);
    setErro(null);
    try {
      await api(`/inbox/conversations/${conversaId}/template`, { method: "POST", body: { templateId: atual.id } });
      setSel("");
      onEnviada();
    } catch (e) {
      setErro(textoDoErro(e));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="inbox-composer">
      <strong>Janela de 24 horas fechada.</strong> Para falar com este cliente agora, envie um <em>template aprovado pela Meta</em>. Se ele responder, a janela reabre e você conversa livremente.
      {opcoes && opcoes.length === 0 && <div style={{ marginTop: 6 }}>Nenhum template aprovado ainda. Crie e envie um para aprovação em <strong>Templates</strong>.</div>}
      {opcoes && opcoes.length > 0 && (
        <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
          <select value={sel} onChange={(e) => setSel(e.target.value)} style={{ minWidth: 220 }}>
            <option value="">Escolha um template…</option>
            {opcoes.map((o) => (
              <option key={o.id} value={o.id}>{o.nome}{o.categoria === "MARKETING" ? " (marketing)" : ""}</option>
            ))}
          </select>
          <button className="btn" disabled={!atual || enviando} onClick={enviar}>{enviando ? "Enviando…" : "Enviar template"}</button>
        </div>
      )}
      {atual && (
        <div className="card" style={{ marginTop: 8, background: "var(--surface-alt)", maxWidth: 460 }}>
          <div className="pd-hint" style={{ marginTop: 0 }}>O cliente vai receber:</div>
          <div style={{ whiteSpace: "pre-wrap", color: "var(--text)" }}>{atual.texto}</div>
          {atual.botoes.map((b) => <div key={b} className="pd-hint">[ {b} ]</div>)}
        </div>
      )}
      {erro && <div className="error-text" style={{ marginTop: 6 }}>{erro}</div>}
    </div>
  );
}

function Composer({ conversaId, janelaAberta, podeEnviar, semAnexo, onEnviada }: { conversaId: string; janelaAberta: boolean; podeEnviar: boolean; semAnexo?: boolean; onEnviada: () => void }) {
  const [texto, setTexto] = useState("");
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTexto("");
    setArquivo(null);
    setErro(null);
  }, [conversaId]);

  if (!podeEnviar) return <div className="inbox-composer">Seu perfil só visualiza conversas. Peça a um operador ou administrador para responder.</div>;
  if (!janelaAberta) return <TemplatePicker conversaId={conversaId} onEnviada={onEnviada} />;

  function escolher(f: File | undefined) {
    setErro(null);
    if (!f) return;
    if (f.size > MAX_ARQUIVO) return setErro(`Arquivo maior que ${MAX_ARQUIVO / 1048576} MB.`);
    setArquivo(f);
  }

  async function enviar() {
    if (enviando) return;
    if (!arquivo && !texto.trim()) return;
    setEnviando(true);
    setErro(null);
    try {
      if (arquivo) {
        await api(`/inbox/conversations/${conversaId}/messages`, {
          method: "POST",
          body: { tipo: "arquivo", nome: arquivo.name, mime: arquivo.type || "application/octet-stream", base64: await lerBase64(arquivo), legenda: texto.trim() || undefined },
        });
      } else {
        await api(`/inbox/conversations/${conversaId}/messages`, { method: "POST", body: { tipo: "text", texto: texto.trim() } });
      }
      setTexto("");
      setArquivo(null);
      onEnviada();
    } catch (e) {
      setErro(textoDoErro(e));
    } finally {
      setEnviando(false);
    }
  }

  function tecla(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void enviar();
    }
  }

  return (
    <div className="inbox-composer">
      {arquivo && (
        <div className="media" style={{ marginBottom: 8 }}>
          📎 {arquivo.name} ({(arquivo.size / 1024).toFixed(0)} KB)
          <button type="button" className="btn secondary" style={{ padding: "2px 8px", fontSize: 11 }} onClick={() => setArquivo(null)}>Remover</button>
        </div>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <input ref={input} type="file" accept={ACEITOS} hidden onChange={(e) => { escolher(e.target.files?.[0]); e.target.value = ""; }} />
        {!semAnexo && <button type="button" className="btn secondary" title="Anexar imagem, PDF, áudio ou vídeo (até 3 MB)" onClick={() => input.current?.click()} disabled={enviando}>📎</button>}
        <textarea
          rows={2}
          style={{ flex: 1, resize: "vertical", minHeight: 44 }}
          placeholder={arquivo ? "Legenda (opcional)" : "Escreva uma resposta. Enter envia, Shift+Enter quebra a linha."}
          value={texto}
          maxLength={4096}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={tecla}
          disabled={enviando}
        />
        <button type="button" className="btn" onClick={enviar} disabled={enviando || (!arquivo && !texto.trim())}>{enviando ? "Enviando…" : "Enviar"}</button>
      </div>
      {erro && <div className="error-text" style={{ marginTop: 6 }}>{erro}</div>}
    </div>
  );
}

interface AutoReplyCfg { ativa: boolean; texto: string; padrao: string; personalizado: boolean; maximo: number; janelaHoras: number }

/** Resposta automática: o que o cliente recebe ao escrever neste número (canal só de avisos). */
function AutoReplyPanel({ podeEditar, onFechar }: { podeEditar: boolean; onFechar: () => void }) {
  const [cfg, setCfg] = useState<AutoReplyCfg | null>(null);
  const [ativa, setAtiva] = useState(true);
  const [texto, setTexto] = useState("");
  const [msg, setMsg] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    api<AutoReplyCfg>("/inbox/auto-reply")
      .then((c) => { setCfg(c); setAtiva(c.ativa); setTexto(c.texto); })
      .catch((e) => setMsg({ tipo: "erro", texto: textoDoErro(e) }));
  }, []);

  async function salvar() {
    setSalvando(true);
    setMsg(null);
    try {
      await api("/inbox/auto-reply", { method: "PUT", body: { ativa, texto } });
      setMsg({ tipo: "ok", texto: "Salvo." });
    } catch (e) {
      setMsg({ tipo: "erro", texto: textoDoErro(e) });
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div className="pd-card-head">
        <strong>Resposta automática</strong>
        <button type="button" className="btn secondary" style={{ padding: "2px 10px" }} onClick={onFechar}>Fechar</button>
      </div>
      <p className="seg-hint" style={{ marginTop: 4 }}>
        Quando um cliente escreve para o número da Meta, ele recebe esta mensagem a cada mensagem dele{cfg ? `, até ${cfg.maximo} vezes a cada ${cfg.janelaHoras} horas por conversa` : ""}. Quem pede para parar (PARAR/SAIR) não recebe.
      </p>
      <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0" }}>
        <input type="checkbox" checked={ativa} disabled={!podeEditar || !cfg} onChange={(e) => setAtiva(e.target.checked)} />
        Responder automaticamente
      </label>
      <textarea rows={6} style={{ width: "100%", resize: "vertical" }} value={texto} maxLength={4096} disabled={!podeEditar || !cfg} onChange={(e) => setTexto(e.target.value)} />
      <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
        {podeEditar ? (
          <>
            <button type="button" className="btn" disabled={salvando || !cfg} onClick={salvar}>{salvando ? "Salvando…" : "Salvar"}</button>
            {cfg && <button type="button" className="btn secondary" onClick={() => setTexto(cfg.padrao)}>Voltar ao texto padrão</button>}
          </>
        ) : (
          <span className="seg-hint">Só o administrador altera.</span>
        )}
        {msg && <span className={msg.tipo === "ok" ? "seg-hint" : "error-text"}>{msg.texto}</span>}
      </div>
    </div>
  );
}

/** Pede permissão para avisar por notificação do navegador (só vale com a aba em segundo plano). */
function AvisoNavegador() {
  const suportado = typeof window !== "undefined" && "Notification" in window;
  const [perm, setPerm] = useState<NotificationPermission>(suportado ? Notification.permission : "denied");
  if (!suportado || perm !== "default") return null;
  return (
    <button type="button" className="btn secondary" onClick={() => Notification.requestPermission().then(setPerm)}>🔔 Ativar avisos no navegador</button>
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

export default function Inbox() {
  const { user } = useAuth();
  const location = useLocation();
  const [mostrarAuto, setMostrarAuto] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [filtro, setFiltro] = useState<"todas" | "nao_lidas" | "janela_aberta" | "sem_cliente">("todas");
  const [busca, setBusca] = useState("");
  const [conversas, setConversas] = useState<Conversa[]>([]);
  const [naoLidas, setNaoLidas] = useState(0);
  const [sel, setSel] = useState<string | null>((location.state as { conversaId?: string } | null)?.conversaId ?? null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [erro, setErro] = useState<string | null>(null);
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

  if (!status.account) {
    return (
      <div>
        <h2>Inbox do WhatsApp</h2>
        <div className="card" style={{ maxWidth: 640 }}>
          <h3>WhatsApp ainda não conectado</h3>
          <p className="seg-hint">
            {status.provider === "ZAPI" ? (
              <>O WhatsApp ativo é a Z-API, mas ela não está configurada. Configure em <Link to="/settings">Configurações → WhatsApp</Link>.</>
            ) : (
              <>
                Para receber e responder mensagens aqui, conecte o número da Meta em <Link to="/integrations">Integrações → WhatsApp</Link>. Lá você
                informa o Phone Number ID, o WABA ID, o Access Token e o App Secret, e copia a URL e o token de verificação do webhook. Para usar a Z-API, veja{" "}
                <Link to="/settings">Configurações → WhatsApp</Link>.
              </>
            )}
          </p>
          <Link to={status.provider === "ZAPI" ? "/settings" : "/integrations"} className="btn" style={{ textDecoration: "none" }}>{status.provider === "ZAPI" ? "Ir para Configurações" : "Ir para Integrações"}</Link>
        </div>
      </div>
    );
  }

  const restante = thread ? tempoRestante(thread.conversa.janelaAte) : "";

  return (
    <div className="inbox-page">
      <div className="pd-card-head">
        <h2 style={{ margin: 0 }}>Inbox do WhatsApp {naoLidas > 0 && <span className="inbox-badge">{naoLidas}</span>}</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <AvisoNavegador />
          <button type="button" className="btn secondary" onClick={() => setMostrarAuto((v) => !v)}>Resposta automática</button>
          <Link to="/integrations" className="btn secondary" style={{ textDecoration: "none" }}>Conexão com a Meta</Link>
        </div>
      </div>
      {mostrarAuto && <AutoReplyPanel podeEditar={user?.role === "ADMIN"} onFechar={() => setMostrarAuto(false)} />}
      {!status.config.appSecret && (
        <div className="card" style={{ borderLeft: "4px solid var(--warning)", marginBottom: 10, fontSize: 13 }}>
          O App Secret não está configurado: as mensagens dos clientes são ignoradas até você informá-lo em Integrações → WhatsApp.
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
                  <span>{c.nome}{c.canal === "ZAPI" && <span className="inbox-chip" style={{ marginLeft: 6, background: "var(--warning-soft)", color: "var(--warning)", fontSize: 10 }}>Z-API</span>}</span>
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
                  {thread.conversa.canal === "ZAPI" ? (
                    <span className="inbox-chip closed">Z-API (não oficial) · sem janela de 24h</span>
                  ) : (
                    <span className={`inbox-chip ${thread.conversa.janelaAberta ? "open" : "closed"}`}>
                      {thread.conversa.janelaAberta ? `Janela de 24h aberta · ${restante}` : "Janela de 24h fechada · só template"}
                    </span>
                  )}
                </div>
              </div>
              <div className="inbox-msgs">
                {thread.mensagens.map((m) => (
                  <div key={m.id} className={`bubble ${m.direcao === "ENTRADA" ? "in" : "out"}${m.automatica ? " auto" : ""}`}>
                    {m.automatica && <span className="auto-tag">🤖 Resposta automática</span>}
                    {m.midia && <Midia m={m} onAbrirImagem={setImagemAberta} />}
                    {m.texto && <div>{m.texto}</div>}
                    {!m.texto && !m.midia && <em style={{ color: "var(--text-muted)" }}>[{m.tipo}]</em>}
                    <time>
                      {new Date(m.em).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                      {m.direcao === "SAIDA" && <Entrega status={m.status} />}
                    </time>
                    {m.direcao === "SAIDA" && m.status === "failed" && <div className="error-text" style={{ fontSize: 11.5 }}>Não entregue: {m.erro ?? "falha no envio"}</div>}
                  </div>
                ))}
                <div ref={fim} />
              </div>
              <Composer
                conversaId={thread.conversa.id}
                janelaAberta={thread.conversa.janelaAberta}
                semAnexo={thread.conversa.canal === "ZAPI"}
                podeEnviar={user?.role === "ADMIN" || user?.role === "OPERATOR"}
                onEnviada={() => { void carregarThread(); void carregarLista(); }}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

import { FormEvent, useCallback, useEffect, useState } from "react";
import { api } from "../api/client";

interface Overview {
  ativo: "META" | "ZAPI";
  meta: { configurado: boolean; numero: string | null; nome: string | null; ultimoTesteOk: boolean | null };
  zapi: {
    configurado: boolean;
    instanceId: string | null;
    tokenDica: string | null;
    clientTokenDica: string | null;
    numero: string | null;
    conectado: boolean | null;
    ultimoTeste: string | null;
    mensagem: string | null;
    webhookUrl: string | null;
  };
}

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

function Copiavel({ valor }: { valor: string }) {
  const [ok, setOk] = useState(false);
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <code style={{ flex: 1, padding: "8px 10px", background: "var(--bg)", borderRadius: 8, wordBreak: "break-all", fontSize: 12.5 }}>{valor}</code>
      <button type="button" className="btn secondary" style={{ padding: "6px 10px", fontSize: 12 }} onClick={() => navigator.clipboard?.writeText(valor).then(() => { setOk(true); setTimeout(() => setOk(false), 1500); })}>
        {ok ? "Copiado" : "Copiar"}
      </button>
    </div>
  );
}

/** Configurações → WhatsApp: escolhe a conexão ativa (Meta oficial ou Z-API) e configura a Z-API. */
export default function WhatsAppProviderCard() {
  const [o, setO] = useState<Overview | null>(null);
  const [msg, setMsg] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [instanceId, setInstanceId] = useState("");
  const [token, setToken] = useState("");
  const [clientToken, setClientToken] = useState("");
  const [qr, setQr] = useState<{ aberto: boolean; img: string | null }>({ aberto: false, img: null });

  const carregar = useCallback(() => api<Overview>("/tenant/whatsapp").then((r) => { setO(r); setInstanceId((v) => v || r.zapi.instanceId || ""); }).catch((e) => setMsg({ tipo: "erro", texto: textoDoErro(e) })), []);
  useEffect(() => void carregar(), [carregar]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ tipo: "erro", texto: textoDoErro(e) });
    } finally {
      setBusy(false);
    }
  }

  const escolher = (provider: "META" | "ZAPI") =>
    run(async () => {
      setO(await api<Overview>("/tenant/whatsapp/ativo", { method: "PUT", body: { provider } }));
      setMsg({ tipo: "ok", texto: `WhatsApp ativo: ${provider === "META" ? "Meta (oficial)" : "Z-API"}.` });
    });

  const salvar = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => {
      const body: Record<string, string> = { instanceId: instanceId.trim() };
      if (token.trim()) body.token = token.trim();
      if (clientToken.trim()) body.clientToken = clientToken.trim();
      setO(await api<Overview>("/tenant/whatsapp/zapi", { method: "PUT", body }));
      setToken("");
      setClientToken("");
      setMsg({ tipo: "ok", texto: "Instância salva. Agora conecte o número pelo QR code e configure os webhooks." });
    });
  };

  const testar = () =>
    run(async () => {
      const r = await api<{ conectado: boolean; mensagem: string }>("/tenant/whatsapp/zapi/test", { method: "POST" });
      setMsg({ tipo: r.conectado ? "ok" : "erro", texto: r.mensagem });
      await carregar();
    });

  const webhooks = () =>
    run(async () => {
      await api("/tenant/whatsapp/zapi/webhooks", { method: "POST" });
      setMsg({ tipo: "ok", texto: "Webhooks da Z-API apontados para o sistema. Mande uma mensagem para o número e veja na Inbox." });
    });

  const desconectar = () =>
    run(async () => {
      if (!window.confirm("Desconectar a Z-API? As conversas continuam no histórico, mas o sistema deixa de receber e enviar por ela.")) return;
      await api("/tenant/whatsapp/zapi", { method: "DELETE" });
      setQr({ aberto: false, img: null });
      setMsg({ tipo: "ok", texto: "Z-API desconectada." });
      await carregar();
    });

  // QR code: renova a cada 8 s (vale ~20 s) até o número conectar
  useEffect(() => {
    if (!qr.aberto) return;
    let vivo = true;
    const buscar = () =>
      api<{ conectado: boolean; qr: string | null }>("/tenant/whatsapp/zapi/qr")
        .then((r) => {
          if (!vivo) return;
          if (r.conectado) {
            setQr({ aberto: false, img: null });
            setMsg({ tipo: "ok", texto: "Número conectado à Z-API." });
            void api("/tenant/whatsapp/zapi/test", { method: "POST" }).finally(() => void carregar());
          } else setQr((q) => ({ ...q, img: r.qr }));
        })
        .catch((e) => vivo && (setMsg({ tipo: "erro", texto: textoDoErro(e) }), setQr({ aberto: false, img: null })));
    void buscar();
    const t = setInterval(buscar, 8000);
    return () => {
      vivo = false;
      clearInterval(t);
    };
  }, [qr.aberto, carregar]);

  if (!o) return <div className="card" style={{ marginBottom: 16 }}>{msg ? <span className="error-text">{msg.texto}</span> : "Carregando WhatsApp…"}</div>;

  const opcao = (id: "META" | "ZAPI", titulo: string, desc: string, cfg: boolean, detalhe: string) => (
    <label key={id} className="card" style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: busy ? "default" : "pointer", flex: "1 1 280px", margin: 0, borderColor: o.ativo === id ? "var(--primary)" : undefined }}>
      <input type="radio" name="whatsapp-ativo" checked={o.ativo === id} disabled={busy} onChange={() => escolher(id)} style={{ marginTop: 4 }} />
      <span>
        <strong>{titulo}</strong> {o.ativo === id && <span className="badge ok">Ativo</span>}
        <span className="seg-hint" style={{ display: "block" }}>{desc}</span>
        <span className="seg-hint" style={{ display: "block", color: cfg ? "var(--success)" : "var(--warning)" }}>{cfg ? detalhe : "Não configurado"}</span>
      </span>
    </label>
  );

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3>WhatsApp</h3>
      <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
        Escolha qual conexão o sistema usa para <strong>enviar</strong> (campanhas). O que chega pelas duas conexões aparece na Inbox, e cada resposta sai pela conexão de onde a conversa veio.
      </p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        {opcao("META", "Meta (oficial)", "WhatsApp Cloud API: template aprovado, janela de 24 h, sem risco de bloqueio. Configurada em Integrações.", o.meta.configurado, o.meta.numero ? `Número ${o.meta.numero}` : "Conectada")}
        {opcao("ZAPI", "Z-API (não oficial)", "Texto livre por QR code, sem template nem janela. Viola os termos do WhatsApp: risco de bloqueio do número.", o.zapi.configurado, o.zapi.numero ? `Número ${o.zapi.numero}` : "Instância salva")}
      </div>
      {msg && <div className="card" style={{ margin: "0 0 12px", borderLeft: `4px solid ${msg.tipo === "ok" ? "var(--success)" : "var(--danger)"}`, fontSize: 13 }}>{msg.texto}</div>}

      <form onSubmit={salvar}>
        <strong style={{ fontSize: 14 }}>Conexão Z-API</strong>
        <span className="seg-hint" style={{ display: "block", margin: "2px 0 8px" }}>
          Crie a instância no painel da Z-API (z-api.io) e copie o ID e o token dela. Use um número <strong>diferente</strong> do número oficial da Meta e evite disparo em massa por ele.
        </span>
        <div className="form-row">
          <label>ID da instância</label>
          <input value={instanceId} onChange={(e) => setInstanceId(e.target.value)} placeholder="Ex: 3E5A1B2C9D0F4A6B8C7D1E2F3A4B5C6D" required />
        </div>
        <div className="form-row">
          <label>Token da instância</label>
          <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={o.zapi.tokenDica ? `••••••••${o.zapi.tokenDica}` : "Cole o token da instância"} required={!o.zapi.configurado} />
          {o.zapi.tokenDica && <span className="seg-hint">Já salvo (cifrado). Deixe em branco para manter.</span>}
        </div>
        <div className="form-row">
          <label>Token de segurança da conta (opcional)</label>
          <input type="password" autoComplete="off" value={clientToken} onChange={(e) => setClientToken(e.target.value)} placeholder={o.zapi.clientTokenDica ? `••••••••${o.zapi.clientTokenDica}` : "Só se você ativou em Segurança, no painel da Z-API"} />
        </div>
        <button className="btn" type="submit" disabled={busy}>Salvar instância</button>
      </form>

      {o.zapi.configurado && (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn secondary" disabled={busy} onClick={testar}>Testar conexão</button>
            <button className="btn secondary" disabled={busy} onClick={() => setQr((q) => ({ aberto: !q.aberto, img: null }))}>{qr.aberto ? "Fechar QR code" : "Conectar por QR code"}</button>
            <button className="btn secondary" disabled={busy} onClick={webhooks}>Configurar webhooks automaticamente</button>
            <button className="btn secondary" disabled={busy} style={{ color: "var(--danger)" }} onClick={desconectar}>Desconectar</button>
          </div>
          {o.zapi.ultimoTeste && (
            <p className="seg-hint" style={{ color: o.zapi.conectado ? "var(--success)" : "var(--warning)" }}>
              Último teste ({new Date(o.zapi.ultimoTeste).toLocaleString("pt-BR")}): {o.zapi.mensagem}
            </p>
          )}
          {qr.aberto && (
            <div style={{ marginTop: 10, textAlign: "center" }}>
              {qr.img ? <img src={qr.img} alt="QR code da Z-API" style={{ width: 240, height: 240, background: "#fff", padding: 8, borderRadius: 8 }} /> : <span className="seg-hint">Gerando o QR code…</span>}
              <span className="seg-hint" style={{ display: "block", marginTop: 6 }}>No celular: WhatsApp → Aparelhos conectados → Conectar um aparelho → aponte para este código. Ele renova sozinho.</span>
            </div>
          )}
          {o.zapi.webhookUrl && (
            <div style={{ marginTop: 12 }}>
              <span className="seg-hint" style={{ display: "block", marginBottom: 4 }}>Se preferir configurar à mão, cole este endereço em todos os webhooks da instância (painel da Z-API → Webhooks). Ele é secreto: não compartilhe.</span>
              <Copiavel valor={o.zapi.webhookUrl} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

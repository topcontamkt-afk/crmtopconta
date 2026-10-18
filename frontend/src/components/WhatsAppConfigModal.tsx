import { FormEvent, useEffect, useState } from "react";
import { api } from "../api/client";

export interface WhatsAppConfig {
  account: {
    phoneNumberId: string;
    wabaId: string | null;
    appId?: string | null;
    displayName: string | null;
    displayPhone: string | null;
    active: boolean;
    accessToken: string | null;
    appSecret: string | null;
    hasCredentials: boolean;
    verifyToken: string | null;
    lastCheckAt: string | null;
    lastCheckOk: boolean | null;
    lastCheckMessage: string | null;
  } | null;
  webhookUrl: string;
  apiVersion: string;
}

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
      <button
        type="button"
        className="btn secondary"
        style={{ padding: "6px 10px", fontSize: 12 }}
        onClick={() => navigator.clipboard?.writeText(valor).then(() => { setOk(true); setTimeout(() => setOk(false), 1500); })}
      >
        {ok ? "Copiado" : "Copiar"}
      </button>
    </div>
  );
}

/** Configurar WhatsApp (Meta Cloud API): credenciais cifradas por conta + dados para colar no painel da Meta. */
export default function WhatsAppConfigModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [cfg, setCfg] = useState<WhatsAppConfig | null>(null);
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [wabaId, setWabaId] = useState("");
  const [appId, setAppId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [msg, setMsg] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);
  const [testes, setTestes] = useState<{ nome: string; ok: boolean; detalhe: string }[] | null>(null);
  const [ligacoes, setLigacoes] = useState<{ nome: string; ok: boolean | null; detalhe: string }[] | null>(null);
  const [busy, setBusy] = useState(false);

  function aplicar(c: WhatsAppConfig) {
    setCfg(c);
    setPhoneNumberId(c.account?.phoneNumberId ?? "");
    setWabaId(c.account?.wabaId ?? "");
    setAppId(c.account?.appId ?? "");
    setAccessToken("");
    setAppSecret("");
  }
  useEffect(() => {
    api<WhatsAppConfig>("/integrations/whatsapp").then(aplicar).catch((e) => setMsg({ tipo: "erro", texto: textoDoErro(e) }));
  }, []);

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

  const salvar = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => {
      const c = await api<WhatsAppConfig>("/integrations/whatsapp", { method: "PUT", body: { phoneNumberId, wabaId, appId, accessToken: accessToken || undefined, appSecret: appSecret || undefined } });
      aplicar(c);
      setTestes(null);
      setMsg({ tipo: "ok", texto: "Configuração salva. Agora clique em “Testar conexão” e depois cole a URL e o token de verificação no painel da Meta." });
      onChanged();
    });
  };
  const testar = () =>
    run(async () => {
      const r = await api<{ ok: boolean; checks: { nome: string; ok: boolean; detalhe: string }[]; ligacoes?: { nome: string; ok: boolean | null; detalhe: string }[] }>("/integrations/whatsapp/test", { method: "POST" });
      setTestes(r.checks);
      setLigacoes(r.ligacoes ?? null);
      setMsg({ tipo: r.ok ? "ok" : "erro", texto: r.ok ? "Conexão com a Meta funcionando." : "A Meta recusou alguma verificação. Veja os detalhes abaixo." });
      aplicar(await api<WhatsAppConfig>("/integrations/whatsapp"));
      onChanged();
    });
  const assinar = () =>
    run(async () => {
      await api("/integrations/whatsapp/subscribe", { method: "POST" });
      setMsg({ tipo: "ok", texto: "App inscrito na conta do WhatsApp Business: a Meta já pode enviar os webhooks." });
    });
  const desconectar = () =>
    window.confirm("Desconectar o WhatsApp? As credenciais são apagadas e os envios param. O histórico de conversas continua salvo.") &&
    run(async () => {
      await api("/integrations/whatsapp", { method: "DELETE" });
      aplicar(await api<WhatsAppConfig>("/integrations/whatsapp"));
      setTestes(null);
      setMsg({ tipo: "ok", texto: "WhatsApp desconectado." });
      onChanged();
    });

  const a = cfg?.account;
  const salvo = !!a?.hasCredentials;

  return (
    <div className="wa-modal-bg" onClick={onClose} role="dialog" aria-label="Configurar WhatsApp">
      <div className="wa-modal" onClick={(e) => e.stopPropagation()}>
        <div className="wa-modal-head">
          <h3 style={{ margin: 0 }}>💬 Configurar WhatsApp</h3>
          <button type="button" className="btn secondary" style={{ padding: "4px 10px" }} onClick={onClose} aria-label="Fechar">✕</button>
        </div>

        <div className="seg-section" style={{ background: "var(--surface-alt)" }}>
          <strong style={{ fontSize: 13 }}>Como configurar (Meta for Developers)</strong>
          <ol style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12.5, lineHeight: 1.7, color: "var(--text-muted)" }}>
            <li>Crie um App tipo “Business” e adicione o produto WhatsApp</li>
            <li>Copie o Phone Number ID e o WABA ID</li>
            <li>Gere um token permanente (System User, em Meta Business Suite)</li>
            <li>Cole os dados abaixo e salve</li>
            <li>No App, cole a URL do webhook e o token de verificação mostrados abaixo</li>
            <li>Assine os campos “messages” e “message_template_status_update” no webhook</li>
          </ol>
        </div>

        {msg && <div className="card" style={{ margin: "10px 0", borderLeft: `4px solid ${msg.tipo === "ok" ? "var(--success)" : "var(--danger)"}`, fontSize: 13 }}>{msg.texto}</div>}

        <form onSubmit={salvar}>
          <div className="form-row">
            <label>Phone Number ID</label>
            <input required value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} placeholder="Ex: 1062259850304758" inputMode="numeric" />
          </div>
          <div className="form-row">
            <label>WhatsApp Business Account ID (WABA)</label>
            <input required value={wabaId} onChange={(e) => setWabaId(e.target.value)} placeholder="Ex: 1008442742213587" inputMode="numeric" />
          </div>
          <div className="form-row">
            <label>ID do app da Meta (opcional)</label>
            <input value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="Só para criar templates com imagem" inputMode="numeric" />
          </div>
          <div className="form-row">
            <label>Access Token (permanente)</label>
            <input type="password" autoComplete="off" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} placeholder={a?.accessToken ?? "Cole o token do System User"} required={!salvo} />
            {a?.accessToken && <span className="seg-hint">Já salvo (cifrado). Deixe em branco para manter.</span>}
          </div>
          <div className="form-row">
            <label>App Secret</label>
            <input type="password" autoComplete="off" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} placeholder={a?.appSecret ?? "Configurações do app > Básico > Chave secreta"} required={!salvo} />
            <span className="seg-hint">Usado para validar a assinatura dos webhooks recebidos. {a?.appSecret ? "Já salvo (cifrado). Deixe em branco para manter." : ""}</span>
          </div>

          <div className="seg-section">
            <strong style={{ fontSize: 13 }}>Configuração do Webhook (Meta App Dashboard)</strong>
            <div className="seg-field">
              <label>URL de Callback</label>
              <span className="seg-hint" style={{ margin: "0 0 6px" }}>Cole em WhatsApp → Configuração → Webhook</span>
              {cfg ? <Copiavel valor={cfg.webhookUrl} /> : "…"}
            </div>
            <div className="seg-field">
              <label>Token de Verificação</label>
              <span className="seg-hint" style={{ margin: "0 0 6px" }}>Cole no campo “Verify Token” junto com a URL acima</span>
              {a?.verifyToken ? <Copiavel valor={a.verifyToken} /> : <span className="seg-hint">Gerado quando você salvar pela primeira vez.</span>}
            </div>
          </div>

          {a?.lastCheckAt && (
            <p className="seg-hint" style={{ color: a.lastCheckOk ? "var(--success)" : "var(--warning)" }}>
              Último teste ({new Date(a.lastCheckAt).toLocaleString("pt-BR")}): {a.lastCheckOk ? "tudo certo" : "com falhas"}
            </p>
          )}
          {testes && (
            <ul style={{ fontSize: 12.5, paddingLeft: 18, margin: "6px 0 10px", lineHeight: 1.7 }}>
              {testes.map((t) => (
                <li key={t.nome} style={{ color: t.ok ? "var(--success)" : "var(--danger)" }}>{t.ok ? "✅" : "❌"} {t.nome}: <span style={{ color: "var(--text-muted)" }}>{t.detalhe}</span></li>
              ))}
            </ul>
          )}
          {ligacoes && (
            <div className="seg-section">
              <strong style={{ fontSize: 13 }}>Ligações pelo WhatsApp (Calling API)</strong>
              <span className="seg-hint" style={{ display: "block", margin: "2px 0 6px" }}>Só diagnóstico: mostra se o número já pode receber ligações da IA.</span>
              <ul style={{ fontSize: 12.5, paddingLeft: 18, margin: 0, lineHeight: 1.7 }}>
                {ligacoes.map((t) => (
                  <li key={t.nome} style={{ color: t.ok === true ? "var(--success)" : t.ok === false ? "var(--danger)" : "var(--warning)" }}>
                    {t.ok === true ? "✅" : t.ok === false ? "❌" : "❔"} {t.nome}: <span style={{ color: "var(--text-muted)" }}>{t.detalhe}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <button className="btn" type="submit" disabled={busy} style={{ width: "100%", background: "var(--success)", color: "#06130b" }}>Salvar Meta Cloud API</button>
          {salvo && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              <button type="button" className="btn secondary" disabled={busy} onClick={testar}>Testar conexão</button>
              <button type="button" className="btn secondary" disabled={busy} onClick={assinar} title="Inscreve o app na conta do WhatsApp Business (POST /{WABA}/subscribed_apps)">Assinar webhook na conta</button>
              <button type="button" className="btn secondary" disabled={busy} style={{ marginLeft: "auto", color: "var(--danger)" }} onClick={desconectar}>Desconectar</button>
            </div>
          )}
          <button type="button" className="btn secondary" style={{ width: "100%", marginTop: 8 }} onClick={onClose}>Fechar</button>
        </form>
      </div>
    </div>
  );
}

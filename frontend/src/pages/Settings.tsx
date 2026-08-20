import { FormEvent, useEffect, useState } from "react";
import { api } from "../api/client";

interface TenantSettings {
  id: string;
  name: string;
  retentionDays: number;
  maxMsgsPerMinute: number;
}

interface ChannelCfg {
  id: string;
  channel: "WHATSAPP" | "SMS";
  provider: string;
  priority: number;
  active: boolean;
}

export default function Settings() {
  const [settings, setSettings] = useState<TenantSettings | null>(null);
  const [retentionDays, setRetentionDays] = useState(1095);
  const [maxMsgsPerMinute, setMaxMsgsPerMinute] = useState(600);
  const [status, setStatus] = useState<string | null>(null);

  const [channels, setChannels] = useState<ChannelCfg[]>([]);
  const [provider, setProvider] = useState("twilio");
  const [priority, setPriority] = useState(0);
  const [credJson, setCredJson] = useState('{"accountSid": "", "authToken": "", "fromNumber": ""}');

  function load() {
    api<TenantSettings>("/tenant/settings").then((s) => {
      setSettings(s);
      setRetentionDays(s.retentionDays);
      setMaxMsgsPerMinute(s.maxMsgsPerMinute);
    });
    api<ChannelCfg[]>("/integrations/channels").then(setChannels);
  }
  useEffect(load, []);

  async function saveSettings(e: FormEvent) {
    e.preventDefault();
    await api("/tenant/settings", { method: "PUT", body: { retentionDays, maxMsgsPerMinute } });
    setStatus("Configurações salvas.");
    load();
  }

  async function addSmsProvider(e: FormEvent) {
    e.preventDefault();
    try {
      const credentials = JSON.parse(credJson);
      await api("/integrations/channels", { method: "PUT", body: { channel: "SMS", provider, credentials, priority } });
      setStatus(`Provedor SMS "${provider}" salvo com prioridade ${priority}.`);
      load();
    } catch {
      setStatus("JSON de credenciais inválido.");
    }
  }

  return (
    <div>
      <h2>Configurações</h2>

      <form className="card" style={{ marginBottom: 16 }} onSubmit={saveSettings}>
        <h3>Política de retenção &amp; rate limit</h3>
        <div className="form-row">
          <label>Retenção de dados (dias) — LGPD, right-to-be-forgotten automático após esse período sem uso</label>
          <input type="number" value={retentionDays} onChange={(e) => setRetentionDays(Number(e.target.value))} />
        </div>
        <div className="form-row">
          <label>Rate limit global (mensagens/minuto, somando todas as campanhas do tenant)</label>
          <input type="number" value={maxMsgsPerMinute} onChange={(e) => setMaxMsgsPerMinute(Number(e.target.value))} />
        </div>
        <button className="btn" type="submit">Salvar</button>
      </form>

      <form className="card" style={{ marginBottom: 16 }} onSubmit={addSmsProvider}>
        <h3>Failover multi-provider de SMS</h3>
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
          Cadastre múltiplos provedores de SMS com prioridade — o de menor número é tentado
          primeiro; se falhar, o próximo é tentado automaticamente no envio.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="twilio">Twilio</option>
            <option value="zenvia">Zenvia</option>
          </select>
          <input type="number" placeholder="Prioridade" value={priority} onChange={(e) => setPriority(Number(e.target.value))} style={{ width: 100 }} />
        </div>
        <div className="form-row">
          <label>Credenciais (JSON)</label>
          <textarea rows={3} value={credJson} onChange={(e) => setCredJson(e.target.value)} />
        </div>
        <button className="btn" type="submit">Salvar provedor</button>
      </form>

      {status && <p>{status}</p>}

      <div className="card">
        <h3>Provedores configurados</h3>
        <table>
          <thead><tr><th>Canal</th><th>Provedor</th><th>Prioridade</th><th>Status</th></tr></thead>
          <tbody>
            {channels.map((c) => (
              <tr key={c.id}>
                <td>{c.channel}</td>
                <td>{c.provider}</td>
                <td>{c.priority}</td>
                <td><span className={`badge ${c.active ? "ok" : ""}`}>{c.active ? "Ativo" : "Inativo"}</span></td>
              </tr>
            ))}
            {channels.length === 0 && (
              <tr><td colSpan={4} style={{ color: "var(--text-muted)" }}>Nenhum provedor configurado (usando variáveis de ambiente/mock)</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

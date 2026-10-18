import { FormEvent, useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import WhatsAppProviderCard from "../components/WhatsAppProviderCard";
import LgpdSettingsCard from "../components/LgpdSettingsCard";

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
  /** só para ADMIN: endereço a configurar no provedor de SMS para receber STOP/SAIR (LGPD 05-05) */
  webhookUrl?: string | null;
}

export default function Settings() {
  const { user } = useAuth();
  const [settings, setSettings] = useState<TenantSettings | null>(null);
  const [maxMsgsPerMinute, setMaxMsgsPerMinute] = useState(600);
  const [status, setStatus] = useState<string | null>(null);

  const [channels, setChannels] = useState<ChannelCfg[]>([]);
  const [provider, setProvider] = useState("twilio");
  const [priority, setPriority] = useState(0);
  const [credJson, setCredJson] = useState('{"accountSid": "", "authToken": "", "fromNumber": ""}');

  function load() {
    api<TenantSettings>("/tenant/settings").then((s) => {
      setSettings(s);
      setMaxMsgsPerMinute(s.maxMsgsPerMinute);
    });
    api<ChannelCfg[]>("/integrations/channels").then(setChannels);
  }
  useEffect(load, []);

  async function saveSettings(e: FormEvent) {
    e.preventDefault();
    // LGPD 04-07: o prazo de retenção mudou para a seção LGPD (com fundamento e prévia do impacto)
    await api("/tenant/settings", { method: "PUT", body: { maxMsgsPerMinute } });
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

      {user?.role === "ADMIN" && <WhatsAppProviderCard />}

      <LgpdSettingsCard isAdmin={user?.role === "ADMIN"} />

      <form className="card" style={{ marginBottom: 16 }} onSubmit={saveSettings}>
        <h3>Limite de envio</h3>
        {settings && (
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
            Retenção de dados: {settings.retentionDays} dias sem uso (ajuste na seção LGPD acima).
          </p>
        )}
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
          primeiro; se falhar, o próximo é tentado automaticamente no envio. Depois de salvar, configure no provedor o endereço da
          coluna "Webhook" da tabela abaixo: é por ele que chega o STOP/SAIR de quem não quer mais receber.
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
          <thead><tr><th>Canal</th><th>Provedor</th><th>Prioridade</th><th>Status</th><th>Webhook (opt-out e status)</th></tr></thead>
          <tbody>
            {channels.map((c) => (
              <tr key={c.id}>
                <td>{c.channel}</td>
                <td>{c.provider}</td>
                <td>{c.priority}</td>
                <td><span className={`badge ${c.active ? "ok" : ""}`}>{c.active ? "Ativo" : "Inativo"}</span></td>
                <td style={{ fontSize: 12, wordBreak: "break-all" }}>
                  {c.channel === "SMS" ? (c.webhookUrl ? <code>{c.webhookUrl}</code> : <span style={{ color: "var(--text-muted)" }}>visível para administradores</span>) : "—"}
                </td>
              </tr>
            ))}
            {channels.length === 0 && (
              <tr><td colSpan={5} style={{ color: "var(--text-muted)" }}>Nenhum provedor de SMS cadastrado: em produção, campanhas por SMS ficam bloqueadas até cadastrar um (fora de produção o envio é só simulado).</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

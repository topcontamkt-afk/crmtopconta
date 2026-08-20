import { FormEvent, useEffect, useState } from "react";
import { api } from "../api/client";

interface Rule {
  id: string;
  name: string;
  trigger: string;
  enabled: boolean;
  lastRunAt: string | null;
}

interface Template {
  id: string;
  channel: "WHATSAPP" | "SMS";
  name: string;
  status: string;
}

const TRIGGERS = [
  ["NOVO_CLIENTE_SEM_USO", "Ativação de cliente novo sem uso"],
  ["INATIVO_30_DIAS", "Reativação após dias inativo"],
  ["LIMITE_RENOVADO", "Aviso de limite renovado"],
  ["ESTIMULO_FAIXA", "Estímulo por faixa de uso"],
  ["OPT_OUT_TELEFONE_INVALIDO", "Bloqueio automático de inconsistências de opt-out"],
] as const;

const ACTION_TYPES = [
  ["notification", "Apenas notificar (in-app)"],
  ["campaign", "Disparar campanha"],
  ["block", "Bloquear cliente"],
] as const;

export default function Automations() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);

  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState<(typeof TRIGGERS)[number][0]>("NOVO_CLIENTE_SEM_USO");
  const [actionType, setActionType] = useState<(typeof ACTION_TYPES)[number][0]>("notification");

  // Condições por gatilho
  const [dias, setDias] = useState(7);
  const [faixa, setFaixa] = useState("USO_INICIAL");

  // Ação "campaign"
  const [channel, setChannel] = useState<"WHATSAPP" | "SMS">("WHATSAPP");
  const [templateId, setTemplateId] = useState("");

  function load() {
    api<Rule[]>("/automations").then(setRules);
  }
  useEffect(load, []);

  useEffect(() => {
    if (actionType === "campaign") {
      api<Template[]>(`/templates?channel=${channel}&status=APROVADO`).then(setTemplates);
    }
  }, [actionType, channel]);

  function buildCondition() {
    if (trigger === "NOVO_CLIENTE_SEM_USO") return { diasDesdeCadastro: dias };
    if (trigger === "INATIVO_30_DIAS") return { dias };
    if (trigger === "LIMITE_RENOVADO") return { horasJanela: dias * 24 };
    if (trigger === "ESTIMULO_FAIXA") return { faixa };
    return {};
  }

  function buildAction() {
    if (actionType === "campaign") return { type: "campaign", channel, templateId: templateId || undefined };
    if (actionType === "block") return { type: "block" };
    return { type: "notification" };
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    await api("/automations", { method: "POST", body: { name, trigger, condition: buildCondition(), action: buildAction() } });
    setName("");
    load();
  }

  async function toggle(rule: Rule) {
    await api(`/automations/${rule.id}`, { method: "PATCH", body: { enabled: !rule.enabled } });
    load();
  }

  return (
    <div>
      <h2>Automações</h2>
      <form className="card" style={{ marginBottom: 16 }} onSubmit={create}>
        <h3>Nova regra</h3>
        <div className="form-row">
          <label>Nome da regra</label>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </div>

        <div className="form-row">
          <label>Gatilho</label>
          <select value={trigger} onChange={(e) => setTrigger(e.target.value as any)}>
            {TRIGGERS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>

        {(trigger === "NOVO_CLIENTE_SEM_USO" || trigger === "INATIVO_30_DIAS" || trigger === "LIMITE_RENOVADO") && (
          <div className="form-row">
            <label>{trigger === "LIMITE_RENOVADO" ? "Janela (dias)" : "Dias"}</label>
            <input type="number" value={dias} onChange={(e) => setDias(Number(e.target.value))} />
          </div>
        )}
        {trigger === "ESTIMULO_FAIXA" && (
          <div className="form-row">
            <label>Faixa de uso</label>
            <select value={faixa} onChange={(e) => setFaixa(e.target.value)}>
              <option value="NAO_UTILIZOU">Não utilizou</option>
              <option value="BAIXO_USO">Baixo uso</option>
              <option value="USO_INICIAL">Uso inicial</option>
              <option value="USO_INTERMEDIARIO">Uso intermediário</option>
              <option value="USO_ALTO">Uso alto</option>
              <option value="QUASE_COMPLETO">Quase completo</option>
            </select>
          </div>
        )}

        <div className="form-row">
          <label>Ação</label>
          <select value={actionType} onChange={(e) => setActionType(e.target.value as any)}>
            {ACTION_TYPES.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>

        {actionType === "campaign" && (
          <>
            <div className="form-row">
              <label>Canal</label>
              <select value={channel} onChange={(e) => setChannel(e.target.value as "WHATSAPP" | "SMS")}>
                <option value="WHATSAPP">WhatsApp</option>
                <option value="SMS">SMS</option>
              </select>
            </div>
            <div className="form-row">
              <label>Template aprovado</label>
              <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} required>
                <option value="">Selecione...</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
          </>
        )}

        <button className="btn" type="submit">Criar</button>
      </form>

      <div className="card">
        <table>
          <thead><tr><th>Nome</th><th>Gatilho</th><th>Status</th><th>Última execução</th><th></th></tr></thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td>{TRIGGERS.find(([v]) => v === r.trigger)?.[1] || r.trigger}</td>
                <td><span className={`badge ${r.enabled ? "ok" : ""}`}>{r.enabled ? "Ativa" : "Inativa"}</span></td>
                <td>{r.lastRunAt ? new Date(r.lastRunAt).toLocaleString("pt-BR") : "—"}</td>
                <td><button className="btn secondary" onClick={() => toggle(r)}>{r.enabled ? "Desativar" : "Ativar"}</button></td>
              </tr>
            ))}
            {rules.length === 0 && (
              <tr><td colSpan={5} style={{ color: "var(--text-muted)" }}>Nenhuma regra criada ainda</td></tr>
            )}
          </tbody>
        </table>
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
          As regras ativas são avaliadas automaticamente a cada 5 minutos pelo backend.
        </p>
      </div>
    </div>
  );
}

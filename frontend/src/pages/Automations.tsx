import { FormEvent, useEffect, useState } from "react";
import { api } from "../api/client";

interface Rule {
  id: string;
  name: string;
  trigger: string;
  enabled: boolean;
}

const TRIGGERS = [
  ["NOVO_CLIENTE_SEM_USO", "Ativação de cliente novo sem uso"],
  ["INATIVO_30_DIAS", "Reativação após 30 dias inativo"],
  ["LIMITE_RENOVADO", "Aviso de limite renovado"],
  ["ESTIMULO_FAIXA", "Estímulo por faixa de uso"],
  ["OPT_OUT_TELEFONE_INVALIDO", "Bloqueio em opt-out/telefone inválido"],
];

export default function Automations() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState(TRIGGERS[0][0]);

  function load() {
    api<Rule[]>("/automations").then(setRules);
  }
  useEffect(load, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    await api("/automations", { method: "POST", body: { name, trigger, action: { type: "notification" } } });
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
        <div style={{ display: "flex", gap: 8 }}>
          <input placeholder="Nome da regra" value={name} onChange={(e) => setName(e.target.value)} required />
          <select value={trigger} onChange={(e) => setTrigger(e.target.value)}>
            {TRIGGERS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <button className="btn" type="submit">Criar</button>
        </div>
      </form>

      <div className="card">
        <table>
          <thead><tr><th>Nome</th><th>Gatilho</th><th>Status</th><th>Ação</th></tr></thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td>{TRIGGERS.find(([v]) => v === r.trigger)?.[1] || r.trigger}</td>
                <td><span className={`badge ${r.enabled ? "ok" : ""}`}>{r.enabled ? "Ativa" : "Inativa"}</span></td>
                <td><button className="btn secondary" onClick={() => toggle(r)}>{r.enabled ? "Desativar" : "Ativar"}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

import { FormEvent, useEffect, useState } from "react";
import { api } from "../api/client";

interface Template {
  id: string;
  channel: "WHATSAPP" | "SMS";
  name: string;
  body: string;
  status: "RASCUNHO" | "PENDENTE_APROVACAO" | "APROVADO" | "REJEITADO";
  rejectionReason: string | null;
}

const STATUS_LABEL: Record<Template["status"], string> = {
  RASCUNHO: "Rascunho",
  PENDENTE_APROVACAO: "Pendente de aprovação",
  APROVADO: "Aprovado",
  REJEITADO: "Rejeitado",
};

export default function Templates() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [channel, setChannel] = useState<"WHATSAPP" | "SMS">("WHATSAPP");
  const [name, setName] = useState("");
  const [body, setBody] = useState("Olá {{nome}}, você já utilizou {{percentual}}% do seu limite!");
  const [preview, setPreview] = useState<string | null>(null);

  function load() {
    api<Template[]>("/templates").then(setTemplates);
  }
  useEffect(load, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    await api("/templates", { method: "POST", body: { channel, name, body } });
    setName("");
    load();
  }

  async function setStatus(id: string, status: Template["status"]) {
    await api(`/templates/${id}`, { method: "PATCH", body: { status } });
    load();
  }

  async function doPreview(id: string) {
    const resp = await api<{ rendered: string }>(`/templates/${id}/preview`, { method: "POST", body: {} });
    setPreview(resp.rendered);
  }

  return (
    <div>
      <h2>Templates de mensagem</h2>
      <form className="card" style={{ marginBottom: 16 }} onSubmit={create}>
        <h3>Novo template</h3>
        <div className="form-row">
          <label>Canal</label>
          <select value={channel} onChange={(e) => setChannel(e.target.value as "WHATSAPP" | "SMS")}>
            <option value="WHATSAPP">WhatsApp</option>
            <option value="SMS">SMS</option>
          </select>
        </div>
        <div className="form-row">
          <label>Nome</label>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="form-row">
          <label>Corpo (placeholders: {"{{nome}}"}, {"{{cidade}}"}, {"{{percentual}}"})</label>
          <textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} required />
        </div>
        <button className="btn" type="submit">Criar template</button>
        {channel === "WHATSAPP" && (
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
            Templates de WhatsApp entram como "Pendente de aprovação" — em produção isso reflete o
            processo de aprovação do provedor; aqui pode ser aprovado manualmente abaixo.
          </p>
        )}
      </form>

      {preview && (
        <div className="card" style={{ marginBottom: 16, background: "var(--surface-alt)" }}>
          <strong>Pré-visualização:</strong>
          <p>{preview}</p>
          <button className="btn secondary" onClick={() => setPreview(null)}>Fechar</button>
        </div>
      )}

      <div className="card">
        <table>
          <thead><tr><th>Nome</th><th>Canal</th><th>Status</th><th>Ações</th></tr></thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td>{t.channel}</td>
                <td>
                  <span className={`badge ${t.status === "APROVADO" ? "ok" : t.status === "REJEITADO" ? "danger" : "warn"}`}>
                    {STATUS_LABEL[t.status]}
                  </span>
                </td>
                <td>
                  <button className="btn secondary" onClick={() => doPreview(t.id)}>Pré-visualizar</button>{" "}
                  {t.status === "PENDENTE_APROVACAO" && (
                    <>
                      <button className="btn secondary" onClick={() => setStatus(t.id, "APROVADO")}>Aprovar</button>{" "}
                      <button className="btn secondary" onClick={() => setStatus(t.id, "REJEITADO")}>Rejeitar</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {templates.length === 0 && (
              <tr><td colSpan={4} style={{ color: "var(--text-muted)" }}>Nenhum template criado ainda</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

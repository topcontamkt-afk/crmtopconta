import { FormEvent, useEffect, useState } from "react";
import { api } from "../api/client";

interface Template {
  id: string;
  channel: "WHATSAPP" | "SMS";
  name: string;
  body: string;
  status: "RASCUNHO" | "PENDENTE_APROVACAO" | "APROVADO" | "REJEITADO";
  rejectionReason: string | null;
  category: string | null;
  footer: string | null;
  quickReplies: string[] | null;
  metaName: string | null;
  metaStatus: string | null;
  qualityScore: string | null;
  version: number;
  variaveis: string[];
}

interface MetaStatus {
  configurado: boolean;
  faltando: string[];
}

const STATUS_LABEL: Record<Template["status"], string> = {
  RASCUNHO: "Rascunho",
  PENDENTE_APROVACAO: "Em análise na Meta",
  APROVADO: "Aprovado",
  REJEITADO: "Não aprovado",
};
const VARIAVEIS = ["nome", "cidade", "percentual", "saldo", "limite", "limite_disponivel"];
const SAMPLE: Record<string, string> = { nome: "Maria", cidade: "Natal", percentual: "45", saldo: "R$ 850,00", limite: "R$ 1.500,00", limite_disponivel: "R$ 850,00" };
const BODY_MAX = 1024;

function textoDoErro(e: any): string {
  const m = String(e?.message ?? "Erro inesperado");
  try {
    const v = JSON.parse(m);
    return typeof v === "string" ? v : m;
  } catch {
    return m;
  }
}

export default function Templates() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [meta, setMeta] = useState<MetaStatus | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [channel, setChannel] = useState<"WHATSAPP" | "SMS">("WHATSAPP");
  const [name, setName] = useState("");
  const [category, setCategory] = useState<"MARKETING" | "UTILITY">("MARKETING");
  const [body, setBody] = useState("Olá {{nome}}, você já utilizou {{percentual}}% do seu limite. Quer saber como usar o restante?");
  const [footer, setFooter] = useState("Responda SAIR para não receber mais mensagens");
  const [botoes, setBotoes] = useState<string[]>(["Quero saber mais", "SAIR", ""]);
  const [msg, setMsg] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  function load() {
    api<Template[]>("/templates").then(setTemplates);
    api<MetaStatus>("/templates/meta-status").then(setMeta).catch(() => setMeta({ configurado: false, faltando: [] }));
  }
  useEffect(load, []);

  const ao = (v: string) => body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => SAMPLE[k] ?? "");
  const wa = channel === "WHATSAPP";

  function limpar() {
    setEditId(null);
    setName("");
  }

  function editar(t: Template) {
    setEditId(t.id);
    setChannel(t.channel);
    setName(t.name);
    setBody(t.body);
    setCategory((t.category as any) ?? "MARKETING");
    setFooter(t.footer ?? "");
    setBotoes([...(t.quickReplies ?? []), "", "", ""].slice(0, 3));
    setMsg(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function salvar(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const extras = wa ? { category, footer: footer.trim() || undefined, quickReplies: botoes.map((b) => b.trim()).filter(Boolean) } : {};
    try {
      if (editId) {
        await api(`/templates/${editId}`, { method: "PATCH", body: { name, body, ...extras, footer: wa ? footer.trim() || null : undefined } });
        setMsg({ tipo: "ok", texto: "Template atualizado. Se ele já tinha sido enviado à Meta, virou uma nova versão e precisa ser enviado de novo." });
      } else {
        await api("/templates", { method: "POST", body: { channel, name, body, ...extras } });
        setMsg({ tipo: "ok", texto: wa ? "Rascunho criado. Revise e clique em “Enviar para aprovação” na lista." : "Template criado." });
      }
      limpar();
      load();
    } catch (err) {
      setMsg({ tipo: "erro", texto: textoDoErro(err) });
    } finally {
      setBusy(false);
    }
  }

  async function acao(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ tipo: "ok", texto: ok });
      load();
    } catch (err) {
      setMsg({ tipo: "erro", texto: textoDoErro(err) });
    } finally {
      setBusy(false);
    }
  }

  const enviar = (t: Template) => acao(() => api(`/templates/${t.id}/submit`, { method: "POST" }), `“${t.name}” enviado à Meta. A análise costuma levar de minutos a algumas horas; o status atualiza sozinho.`);
  const excluir = (t: Template) => window.confirm(`Excluir “${t.name}”? Se já estiver na Meta, ele também será removido de lá.`) && acao(() => api(`/templates/${t.id}`, { method: "DELETE" }), "Template excluído.");
  const sincronizar = () =>
    acao(async () => {
      const r = await api<{ atualizados: number; total: number; somenteNaMeta: { name: string }[] }>("/templates/sync", { method: "POST" });
      setMsg({ tipo: "ok", texto: `Sincronizado: ${r.total} template(s) na Meta, ${r.atualizados} atualizado(s) aqui.${r.somenteNaMeta.length ? ` ${r.somenteNaMeta.length} existem só na Meta (criados direto no painel).` : ""}` });
    }, "");
  const setStatus = (id: string, status: Template["status"]) => acao(() => api(`/templates/${id}`, { method: "PATCH", body: { status } }), "Status alterado manualmente (ambiente sem Meta).");
  const doPreview = async (id: string) => setPreview((await api<{ rendered: string }>(`/templates/${id}/preview`, { method: "POST", body: {} })).rendered);

  return (
    <div>
      <h2>Templates de mensagem</h2>

      <div className="card seg-intro" style={{ marginBottom: 16 }}>
        <h3>Para que servem os templates?</h3>
        <p>
          No WhatsApp, só dá para escrever primeiro a um cliente (ou depois de 24 horas sem resposta dele) com um <strong>template aprovado pela Meta</strong>. Cada
          template passa por uma análise: você escreve aqui, envia para aprovação e, quando aprovado, ele pode ser usado nas campanhas e na Inbox.
        </p>
        <ul>
          <li><strong>Categoria:</strong> <em>Marketing</em> para ofertas e reativação; <em>Utilidade</em> para avisos que o cliente espera (ex.: limite renovado). A Meta confere e pode reclassificar.</li>
          <li><strong>Regras que mais reprovam:</strong> não começar nem terminar o texto com variável, não deixar duas variáveis coladas, não prometer o que não pode cumprir e oferecer um jeito de recusar (ex.: “Responda SAIR”).</li>
          <li><strong>Mudou o texto de um template já enviado?</strong> Vira uma nova versão e precisa de nova aprovação.</li>
        </ul>
      </div>

      {meta && (
        <div className="card" style={{ marginBottom: 16, borderLeft: `4px solid ${meta.configurado ? "var(--success)" : "var(--warning)"}`, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 13 }}>
            {meta.configurado ? "Conectado à Meta: os templates são enviados para aprovação de verdade." : `Meta ainda não conectada em Integrações → WhatsApp (falta: ${meta.faltando.join(", ") || "configuração"}). Sem ela, a aprovação é manual e só serve para testes.`}
          </span>
          {meta.configurado && <button className="btn secondary" disabled={busy} onClick={sincronizar}>Sincronizar com a Meta</button>}
        </div>
      )}

      {msg && <div className="card" style={{ marginBottom: 12, borderLeft: `4px solid ${msg.tipo === "ok" ? "var(--success)" : "var(--danger)"}`, fontSize: 13 }}>{msg.texto}</div>}

      <form className="card" style={{ marginBottom: 16 }} onSubmit={salvar}>
        <h3>{editId ? "Editar template" : "Novo template"}</h3>
        <div className="seg-row">
          <div className="form-row">
            <label>Canal</label>
            <select value={channel} disabled={!!editId} onChange={(e) => setChannel(e.target.value as "WHATSAPP" | "SMS")}>
              <option value="WHATSAPP">WhatsApp</option>
              <option value="SMS">SMS</option>
            </select>
          </div>
          <div className="form-row">
            <label>Nome (só para você identificar)</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Ex: Oferta de antecipação" />
          </div>
          {wa && (
            <div className="form-row">
              <label>Categoria</label>
              <select value={category} onChange={(e) => setCategory(e.target.value as any)}>
                <option value="MARKETING">Marketing (ofertas, reativação)</option>
                <option value="UTILITY">Utilidade (avisos esperados)</option>
              </select>
            </div>
          )}
        </div>

        <div className="form-row">
          <label>Texto da mensagem {wa && <span style={{ float: "right" }}>{body.length}/{BODY_MAX}</span>}</label>
          <textarea rows={4} value={body} maxLength={wa ? BODY_MAX : undefined} onChange={(e) => setBody(e.target.value)} required />
          <div className="chip-group" style={{ marginTop: 6 }}>
            {VARIAVEIS.map((v) => (
              <button key={v} type="button" className="btn secondary" style={{ padding: "2px 10px", fontSize: 12 }} onClick={() => setBody((b) => `${b}{{${v}}}`)}>
                + {`{{${v}}}`}
              </button>
            ))}
          </div>
        </div>

        {wa && (
          <>
            <div className="seg-row">
              <div className="form-row">
                <label>Rodapé (opcional, até 60 caracteres)</label>
                <input value={footer} maxLength={60} onChange={(e) => setFooter(e.target.value)} />
              </div>
            </div>
            <div className="form-row">
              <label>Botões de resposta rápida (opcional, até 3)</label>
              <div className="seg-row">
                {botoes.map((b, i) => (
                  <input key={i} value={b} maxLength={25} placeholder={`Botão ${i + 1}`} onChange={(e) => setBotoes((arr) => arr.map((x, j) => (j === i ? e.target.value : x)))} />
                ))}
              </div>
              <span className="seg-hint">Quem toca no botão “SAIR” é descadastrado automaticamente.</span>
            </div>
          </>
        )}

        <div className="card" style={{ background: "var(--surface-alt)", maxWidth: 420 }}>
          <strong style={{ fontSize: 12 }}>Como o cliente vai ver:</strong>
          <p style={{ whiteSpace: "pre-wrap", margin: "6px 0" }}>{ao(body)}</p>
          {wa && footer && <div className="pd-hint">{footer}</div>}
          {wa && botoes.filter(Boolean).map((b) => <div key={b} style={{ marginTop: 4, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: 8, textAlign: "center", fontSize: 12 }}>{b}</div>)}
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button className="btn" type="submit" disabled={busy}>{editId ? "Salvar alterações" : wa ? "Criar rascunho" : "Criar template"}</button>
          {editId && <button type="button" className="btn secondary" onClick={limpar}>Cancelar edição</button>}
        </div>
      </form>

      {preview && (
        <div className="card" style={{ marginBottom: 16, background: "var(--surface-alt)" }}>
          <strong>Pré-visualização:</strong>
          <p style={{ whiteSpace: "pre-wrap" }}>{preview}</p>
          <button className="btn secondary" onClick={() => setPreview(null)}>Fechar</button>
        </div>
      )}

      <div className="card">
        <table>
          <thead><tr><th>Nome</th><th>Canal</th><th>Status</th><th>Ações</th></tr></thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.id}>
                <td>
                  {t.name}
                  {t.channel === "WHATSAPP" && <div className="pd-hint">{t.category === "UTILITY" ? "Utilidade" : "Marketing"}{t.metaName ? ` · ${t.metaName}` : ""}{t.version > 1 ? ` · versão ${t.version}` : ""}</div>}
                </td>
                <td>{t.channel}</td>
                <td>
                  <span className={`badge ${t.status === "APROVADO" ? "ok" : t.status === "REJEITADO" ? "danger" : "warn"}`}>{STATUS_LABEL[t.status]}</span>
                  {t.metaStatus && t.metaStatus !== "APPROVED" && t.metaStatus !== "PENDING" && <div className="pd-hint">Meta: {t.metaStatus}</div>}
                  {t.qualityScore && t.qualityScore !== "UNKNOWN" && <div className="pd-hint">Qualidade: {t.qualityScore === "GREEN" ? "alta" : t.qualityScore === "YELLOW" ? "média" : "baixa"}</div>}
                  {t.rejectionReason && <div className="pd-hint" style={{ color: "var(--warning)" }}>{t.rejectionReason}</div>}
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button className="btn secondary" onClick={() => doPreview(t.id)}>Pré-visualizar</button>{" "}
                  <button className="btn secondary" onClick={() => editar(t)}>Editar</button>{" "}
                  {t.channel === "WHATSAPP" && !t.metaName && meta?.configurado && (
                    <><button className="btn" disabled={busy} onClick={() => enviar(t)}>Enviar para aprovação</button>{" "}</>
                  )}
                  {t.channel === "WHATSAPP" && meta && !meta.configurado && t.status !== "APROVADO" && (
                    <><button className="btn secondary" onClick={() => setStatus(t.id, "APROVADO")}>Aprovar (teste)</button>{" "}</>
                  )}
                  <button className="btn secondary" disabled={busy} onClick={() => excluir(t)}>Excluir</button>
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

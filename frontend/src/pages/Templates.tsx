import React, { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import TemplatePreview from "../components/campaign/TemplatePreview";
import VariableMapEditor from "../components/campaign/VariableMapEditor";
import { WaTemplate } from "../components/campaign/types";

type Status = "RASCUNHO" | "PENDENTE_APROVACAO" | "APROVADO" | "REJEITADO";
type Template = WaTemplate & { channel: "WHATSAPP" | "SMS"; status: Status; updatedAt: string };

interface MetaStatus {
  configurado: boolean;
  faltando: string[];
}

const STATUS_LABEL: Record<Status, string> = {
  RASCUNHO: "Rascunho",
  PENDENTE_APROVACAO: "Em análise",
  APROVADO: "Aprovado",
  REJEITADO: "Rejeitado",
};
const IMAGEM_MAX = 3 * 1024 * 1024;

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
    r.onerror = () => reject(new Error("Não consegui ler a imagem"));
    r.readAsDataURL(file);
  });
}

export default function Templates() {
  const navigate = useNavigate();
  const location = useLocation();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [meta, setMeta] = useState<MetaStatus | null>(null);
  const [msg, setMsg] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(
    (location.state as { aviso?: string } | null)?.aviso ? { tipo: "ok", texto: (location.state as { aviso: string }).aviso } : null
  );
  const [busy, setBusy] = useState(false);
  const [categoria, setCategoria] = useState<"" | "MARKETING" | "UTILITY">("");
  const [status, setStatus] = useState<"" | Status>("APROVADO");
  const [busca, setBusca] = useState("");
  const [previa, setPrevia] = useState<Template | null>(null);
  const [mapaAberto, setMapaAberto] = useState<string | null>(null);
  const [smsAberto, setSmsAberto] = useState(false);
  const [smsNome, setSmsNome] = useState("");
  const [smsTexto, setSmsTexto] = useState("");

  function load() {
    api<Template[]>("/templates").then(setTemplates);
    api<MetaStatus>("/templates/meta-status").then(setMeta).catch(() => setMeta({ configurado: false, faltando: [] }));
  }
  useEffect(load, []);

  const contagem = useMemo(() => {
    const base = templates.filter((t) => !categoria || t.category === categoria);
    const c = (s: Status) => base.filter((t) => t.status === s).length;
    return { APROVADO: c("APROVADO"), PENDENTE_APROVACAO: c("PENDENTE_APROVACAO"), REJEITADO: c("REJEITADO"), RASCUNHO: c("RASCUNHO"), todos: base.length };
  }, [templates, categoria]);

  const lista = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return templates.filter((t) => (!categoria || t.category === categoria) && (!status || t.status === status) && (!q || t.name.toLowerCase().includes(q) || t.body.toLowerCase().includes(q)));
  }, [templates, categoria, status, busca]);

  async function acao(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ tipo: "ok", texto: ok });
      load();
    } catch (err) {
      setMsg({ tipo: "erro", texto: textoDoErro(err) });
    } finally {
      setBusy(false);
    }
  }

  const enviar = (t: Template) => acao(() => api(`/templates/${t.id}/submit`, { method: "POST" }), `“${t.name}” enviado à Meta. A análise costuma levar de minutos a algumas horas; o status atualiza sozinho.`);
  const excluir = (t: Template) =>
    window.confirm(
      t.origin === "META"
        ? `Tirar “${t.name}” do sistema? Ele continua na Meta (pode estar em uso em outro lugar) e volta na próxima sincronização.`
        : `Excluir “${t.name}”? Se já estiver na Meta, ele também será removido de lá.`
    ) && acao(() => api(`/templates/${t.id}`, { method: "DELETE" }), "Template excluído.");
  const trocarImagem = async (t: Template, file: File | undefined) => {
    if (!file) return;
    if (file.size > IMAGEM_MAX) return setMsg({ tipo: "erro", texto: "A imagem passa de 3 MB." });
    await acao(async () => api(`/templates/${t.id}/header`, { method: "PUT", body: { data: await lerBase64(file), mime: file.type, filename: file.name } }), "Imagem do cabeçalho atualizada.");
  };
  const sincronizar = () =>
    acao(async () => {
      const r = await api<{ atualizados: number; importados: number; total: number; somenteNaMeta: { name: string }[] }>("/templates/sync", { method: "POST" });
      setMsg({ tipo: "ok", texto: `Sincronizado: ${r.total} template(s) na Meta, ${r.atualizados} atualizado(s) e ${r.importados} importado(s) para cá.${r.somenteNaMeta.length ? ` ${r.somenteNaMeta.length} ficaram de fora (autenticação, reprovados ou desativados).` : ""}` });
    }, "");
  const aprovarTeste = (id: string) => acao(() => api(`/templates/${id}`, { method: "PATCH", body: { status: "APROVADO" } }), "Status alterado manualmente (ambiente sem Meta).");
  const usarEmCampanha = (t: Template) => navigate("/campaigns/new", { state: { presetTemplateId: t.id } });

  async function criarSms(e: FormEvent) {
    e.preventDefault();
    await acao(() => api("/templates", { method: "POST", body: { channel: "SMS", name: smsNome, body: smsTexto } }), "Template de SMS criado.");
    setSmsNome("");
    setSmsTexto("");
    setSmsAberto(false);
  }

  const podeEnviar = (t: Template) => t.channel === "WHATSAPP" && t.origin !== "META" && !t.metaName && meta?.configurado;

  return (
    <div>
      <div className="topbar">
        <div>
          <h2 style={{ margin: 0 }}>Templates</h2>
          <p className="pd-sub">Gerencie templates e rascunhos.</p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Link className="btn" to="/templates/new">+ Criar template</Link>
          {meta?.configurado && <button className="btn secondary" disabled={busy} onClick={sincronizar}>⟳ Sincronizar</button>}
          <button className="btn secondary" onClick={() => setSmsAberto(!smsAberto)}>Template SMS</button>
        </div>
      </div>

      {meta && !meta.configurado && (
        <div className="card" style={{ marginBottom: 12, borderLeft: "4px solid var(--warning)", fontSize: 13 }}>
          Meta ainda não conectada em Integrações → WhatsApp (falta: {meta.faltando.join(", ") || "configuração"}). Sem ela, a aprovação é manual e só serve para testes.
        </div>
      )}
      {msg && <div className="card" style={{ marginBottom: 12, borderLeft: `4px solid ${msg.tipo === "ok" ? "var(--success)" : "var(--danger)"}`, fontSize: 13 }}>{msg.texto}</div>}

      {smsAberto && (
        <form className="card" style={{ marginBottom: 12 }} onSubmit={criarSms}>
          <h3>Novo template de SMS</h3>
          <div className="form-row">
            <label>Nome</label>
            <input value={smsNome} onChange={(e) => setSmsNome(e.target.value)} required />
          </div>
          <div className="form-row">
            <label>Texto (variáveis como {"{{nome}}"}, {"{{limite_disponivel}}"})</label>
            <textarea rows={3} value={smsTexto} onChange={(e) => setSmsTexto(e.target.value)} required />
          </div>
          <button className="btn" type="submit" disabled={busy}>Criar</button>
        </form>
      )}

      <div className="card" style={{ marginBottom: 12, display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center", justifyContent: "space-between" }}>
        <div className="tpl-chips">
          {([["", "Todos"], ["MARKETING", "Marketing"], ["UTILITY", "Utilidade"]] as const).map(([k, l]) => (
            <button key={k} type="button" className={`tpl-chip ${categoria === k ? "active" : ""}`} onClick={() => setCategoria(k)}>{l}</button>
          ))}
        </div>
        <div className="tpl-chips">
          {([["APROVADO", "Aprovados", contagem.APROVADO], ["PENDENTE_APROVACAO", "Em análise", contagem.PENDENTE_APROVACAO], ["REJEITADO", "Rejeitados", contagem.REJEITADO], ["RASCUNHO", "Rascunhos", contagem.RASCUNHO], ["", "Todos", contagem.todos]] as const).map(([k, l, n]) => (
            <button key={k} type="button" className={`tpl-chip ${status === k ? "active" : ""}`} onClick={() => setStatus(k as any)}>{l} ({n})</button>
          ))}
        </div>
        <input style={{ minWidth: 220 }} value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar templates..." aria-label="Buscar templates" />
      </div>

      <div className="card" style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr><th>Nome</th><th>Status</th><th>Categoria</th><th>Conteúdo</th><th>Atualizado</th><th>Ações</th></tr>
          </thead>
          <tbody>
            {lista.map((t) => (
              <React.Fragment key={t.id}>
                <tr>
                  <td>
                    {t.name}
                    <div className="pd-hint">
                      {t.channel === "SMS" ? "SMS" : "WhatsApp"}
                      {t.metaName && t.origin !== "META" ? ` · ${t.metaName}` : ""}
                      {(t.version ?? 1) > 1 ? ` · versão ${t.version}` : ""}
                      {t.origin === "META" ? " · veio da Meta" : ""}
                      {t.imagem ? " · com imagem" : t.headerFormat === "IMAGE" ? " · falta a imagem" : ""}
                      {(t.buttons?.length ?? 0) + (t.quickReplies?.length ?? 0) > 0 ? ` · ${(t.buttons?.length ?? 0) + (t.quickReplies?.length ?? 0)} botão(ões)` : ""}
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${t.status === "APROVADO" ? "ok" : t.status === "REJEITADO" ? "danger" : "warn"}`}>{STATUS_LABEL[t.status]}</span>
                    {t.metaStatus && t.metaStatus !== "APPROVED" && t.metaStatus !== "PENDING" && <div className="pd-hint">Meta: {t.metaStatus}</div>}
                    {t.qualityScore && t.qualityScore !== "UNKNOWN" && <div className="pd-hint">Qualidade: {t.qualityScore === "GREEN" ? "alta" : t.qualityScore === "YELLOW" ? "média" : "baixa"}</div>}
                    {t.rejectionReason && <div className="pd-hint" style={{ color: "var(--warning)" }}>{t.rejectionReason}</div>}
                    {t.sendIssue && <div className="pd-hint" style={{ color: "var(--warning)" }}>Não envia por aqui: {t.sendIssue}</div>}
                    {!!t.variaveisSemMapa?.length && <div className="pd-hint" style={{ color: "var(--warning)" }}>Defina o que cada variável significa para poder enviar.</div>}
                  </td>
                  <td>{t.channel === "WHATSAPP" ? <span className="badge">{t.category === "UTILITY" ? "UTILIDADE" : "MARKETING"}</span> : "—"}</td>
                  <td><div className="tpl-content">{t.body}</div></td>
                  <td style={{ whiteSpace: "nowrap", color: "var(--text-muted)", fontSize: 12 }}>{t.updatedAt ? new Date(t.updatedAt).toLocaleDateString("pt-BR") : ""}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {t.channel === "WHATSAPP" && <button className="btn secondary" onClick={() => setPrevia(t)}>Pré-visualizar</button>}
                      {t.channel === "WHATSAPP" && t.origin !== "META" && <Link className="btn secondary" to={`/templates/${t.id}/edit`}>Editar</Link>}
                      {t.channel === "WHATSAPP" && !!t.metaBody && !!t.variaveis.length && (
                        <button className="btn secondary" onClick={() => setMapaAberto(mapaAberto === t.id ? null : t.id)}>Variáveis</button>
                      )}
                      {t.channel === "WHATSAPP" && t.origin === "META" && t.headerFormat === "IMAGE" && (
                        <label className="btn secondary" style={{ cursor: "pointer" }}>
                          {t.imagem ? "Trocar imagem" : "Enviar imagem"}
                          <input type="file" accept="image/jpeg,image/png" style={{ display: "none" }} onChange={(e) => trocarImagem(t, e.target.files?.[0])} />
                        </label>
                      )}
                      {t.channel === "WHATSAPP" && t.status === "APROVADO" && <button className="btn secondary" onClick={() => usarEmCampanha(t)}>Usar em campanha</button>}
                      {podeEnviar(t) && <button className="btn" disabled={busy} onClick={() => enviar(t)}>Enviar para aprovação</button>}
                      {t.channel === "WHATSAPP" && meta && !meta.configurado && t.status !== "APROVADO" && (
                        <button className="btn secondary" onClick={() => aprovarTeste(t.id)}>Aprovar (teste)</button>
                      )}
                      <button className="btn secondary" disabled={busy} onClick={() => excluir(t)}>Excluir</button>
                    </div>
                  </td>
                </tr>
                {mapaAberto === t.id && (
                  <tr>
                    <td colSpan={6}>
                      <VariableMapEditor template={t} onSaved={() => { setMapaAberto(null); load(); setMsg({ tipo: "ok", texto: "Variáveis salvas." }); }} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
            {lista.length === 0 && (
              <tr><td colSpan={6} style={{ color: "var(--text-muted)" }}>{templates.length === 0 ? "Nenhum template ainda. Clique em “Criar template” ou sincronize com a Meta." : "Nenhum template neste filtro."}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {previa && (
        <div className="dsb-palette-overlay" onClick={() => setPrevia(null)}>
          <div className="card" style={{ maxWidth: 420, width: "92%", margin: "8vh auto" }} onClick={(e) => e.stopPropagation()}>
            <div className="cw-side-head">
              <strong>{previa.name}</strong>
              <button className="btn secondary" onClick={() => setPrevia(null)}>Fechar</button>
            </div>
            <TemplatePreview template={previa} />
          </div>
        </div>
      )}
    </div>
  );
}

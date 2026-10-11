import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import TemplatePreview from "../components/campaign/TemplatePreview";
import { SAMPLE_CTX, VARIAVEIS_NOSSAS, WaTemplate } from "../components/campaign/types";

const STEPS = ["Configuração", "Conteúdo", "Botões"];
const BODY_MAX = 1024;
const FOOTER_MAX = 60;
const BTN_TEXT_MAX = 25;
const IMAGEM_MAX = 3 * 1024 * 1024;

type BotaoTipo = "QUICK_REPLY" | "URL" | "PHONE_NUMBER";
interface Botao {
  key: number;
  tipo: BotaoTipo;
  text: string;
  url: string;
  phone: string;
}

const LIMITES: Record<BotaoTipo, { max: number; label: string }> = {
  QUICK_REPLY: { max: 10, label: "Resposta rápida" },
  URL: { max: 2, label: "Visitar site" },
  PHONE_NUMBER: { max: 1, label: "Ligar" },
};

function textoErro(e: unknown): string {
  const m = e instanceof Error ? e.message : "Erro inesperado";
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

let nextKey = 1;

/** Criar/editar template do WhatsApp em 3 passos: Configuração, Conteúdo e Botões, com preview ao lado. */
export default function TemplateEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const [step, setStep] = useState(0);
  const [carregando, setCarregando] = useState(!!id);
  const [existente, setExistente] = useState<WaTemplate | null>(null);
  const [metaOk, setMetaOk] = useState(false);

  const [name, setName] = useState("");
  const [language, setLanguage] = useState("pt_BR");
  const [category, setCategory] = useState<"MARKETING" | "UTILITY">("MARKETING");
  const [cabecalho, setCabecalho] = useState<"NONE" | "IMAGE">("NONE");
  const [imagem, setImagem] = useState<File | null>(null);
  const [imagemUrl, setImagemUrl] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [footer, setFooter] = useState<string | null>(null);
  const [botoes, setBotoes] = useState<Botao[]>([]);
  const [menuBotao, setMenuBotao] = useState(false);
  const [menuVar, setMenuVar] = useState(false);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState("");

  useEffect(() => {
    api<{ configurado: boolean }>("/templates/meta-status").then((m) => setMetaOk(m.configurado)).catch(() => {});
    if (!id) {
      setName(`template_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}_${String(Date.now()).slice(-4)}`);
      return;
    }
    api<(WaTemplate & { channel: string; language: string })[]>("/templates")
      .then((lista) => {
        const t = lista.find((x) => x.id === id);
        if (!t) throw new Error("Template não encontrado");
        if (t.origin === "META") throw new Error("Este template veio da Meta: o texto só muda lá. Você pode criar um novo aqui.");
        setExistente(t);
        setName(t.name);
        setLanguage(t.language || "pt_BR");
        setCategory((t.category as any) === "UTILITY" ? "UTILITY" : "MARKETING");
        setBody(t.body);
        setFooter(t.footer || null);
        setCabecalho(t.headerFormat === "IMAGE" ? "IMAGE" : "NONE");
        setBotoes([
          ...(t.quickReplies ?? []).map((text) => ({ key: nextKey++, tipo: "QUICK_REPLY" as const, text, url: "", phone: "" })),
          ...(t.buttons ?? []).map((b) => ({ key: nextKey++, tipo: b.type as BotaoTipo, text: b.text, url: b.url ?? "", phone: b.phone ?? "" })),
        ]);
      })
      .catch((e) => setErro(textoErro(e)))
      .finally(() => setCarregando(false));
  }, [id]);

  function escolherImagem(file: File | null) {
    if (imagemUrl) URL.revokeObjectURL(imagemUrl);
    if (file && file.size > IMAGEM_MAX) {
      setErro("A imagem passa de 3 MB.");
      return;
    }
    setErro("");
    setImagem(file);
    setImagemUrl(file ? URL.createObjectURL(file) : null);
  }

  /* ───────── corpo: formatação e variáveis ───────── */
  function envolver(marca: string) {
    const el = bodyRef.current;
    if (!el) return;
    const ini = el.selectionStart;
    const fim = el.selectionEnd;
    const sel = body.slice(ini, fim) || "texto";
    const novo = body.slice(0, ini) + marca + sel + marca + body.slice(fim);
    setBody(novo);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(ini + marca.length, ini + marca.length + sel.length);
    });
  }
  function inserirVariavel(key: string) {
    const el = bodyRef.current;
    const pos = el ? el.selectionStart : body.length;
    setBody(body.slice(0, pos) + `{{${key}}}` + body.slice(pos));
    setMenuVar(false);
    requestAnimationFrame(() => el?.focus());
  }

  /* ───────── botões ───────── */
  const contagem = (t: BotaoTipo) => botoes.filter((b) => b.tipo === t).length;
  const totalBotoes = botoes.length;
  function adicionar(tipo: BotaoTipo) {
    setBotoes([...botoes, { key: nextKey++, tipo, text: "", url: tipo === "URL" ? "https://" : "", phone: "" }]);
    setMenuBotao(false);
  }
  const atualizar = (key: number, patch: Partial<Botao>) => setBotoes(botoes.map((b) => (b.key === key ? { ...b, ...patch } : b)));
  const remover = (key: number) => setBotoes(botoes.filter((b) => b.key !== key));
  const mover = (key: number, dir: -1 | 1) => {
    const i = botoes.findIndex((b) => b.key === key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= botoes.length) return;
    const copia = [...botoes];
    [copia[i], copia[j]] = [copia[j], copia[i]];
    setBotoes(copia);
  };

  /* ───────── validação leve na tela (a completa é do servidor) ───────── */
  const problemasBotoes = useMemo(() => {
    const out: string[] = [];
    for (const b of botoes) {
      if (!b.text.trim()) out.push("Preencha o texto dos botões.");
      if (b.tipo === "URL" && !/^https:\/\/.+\..+/.test(b.url.trim())) out.push("O link precisa começar com https://.");
      if (b.tipo === "PHONE_NUMBER" && b.phone.replace(/\D/g, "").length < 8) out.push("Informe o telefone do botão de ligar.");
    }
    const textos = botoes.map((b) => b.text.trim().toLowerCase()).filter(Boolean);
    if (new Set(textos).size !== textos.length) out.push("Há botões com o mesmo texto.");
    return [...new Set(out)];
  }, [botoes]);

  const passo0Ok = name.trim() !== "";
  const passo1Ok = body.trim() !== "" && body.length <= BODY_MAX && (cabecalho === "NONE" || !!imagem || !!existente?.imagem);
  const motivoPasso1 = body.trim() === "" ? "Preencha o corpo do template para continuar" : cabecalho === "IMAGE" && !imagem && !existente?.imagem ? "Escolha a imagem do cabeçalho" : "";
  const passo2Ok = problemasBotoes.length === 0;
  const podeContinuar = [passo0Ok, passo1Ok, passo2Ok][step];

  /* ───────── preview ───────── */
  const preview = useMemo<WaTemplate>(
    () => ({
      id: existente?.id ?? "novo",
      name,
      body,
      variaveis: [],
      variaveisSemMapa: [],
      status: "RASCUNHO",
      metaStatus: null,
      category,
      footer: footer?.trim() || null,
      quickReplies: botoes.filter((b) => b.tipo === "QUICK_REPLY").map((b) => b.text),
      buttons: botoes.filter((b) => b.tipo !== "QUICK_REPLY").map((b) => ({ type: b.tipo, text: b.text, url: b.url, phone: b.phone })),
      headerFormat: cabecalho === "IMAGE" ? "IMAGE" : null,
      imagem: cabecalho === "IMAGE" ? existente?.imagem ?? (imagem ? { mime: imagem.type, size: imagem.size, filename: imagem.name } : null) : null,
      qualityScore: null,
    }),
    [existente, name, body, category, footer, botoes, cabecalho, imagem]
  );

  /* ───────── salvar / enviar ───────── */
  async function salvar(): Promise<string> {
    const payload = {
      name: name.trim(),
      body,
      category,
      language,
      footer: footer?.trim() ? footer.trim() : undefined,
      quickReplies: botoes.filter((b) => b.tipo === "QUICK_REPLY").map((b) => b.text.trim()),
      buttons: botoes.filter((b) => b.tipo !== "QUICK_REPLY").map((b) => ({ type: b.tipo, text: b.text.trim(), url: b.tipo === "URL" ? b.url.trim() : undefined, phone: b.tipo === "PHONE_NUMBER" ? b.phone.trim() : undefined })),
    };
    let tid = id ?? "";
    if (id) {
      await api(`/templates/${id}`, { method: "PATCH", body: { ...payload, footer: footer?.trim() ? footer.trim() : null } });
    } else {
      const criado = await api<{ id: string }>("/templates", { method: "POST", body: { channel: "WHATSAPP", ...payload } });
      tid = criado.id;
    }
    if (cabecalho === "IMAGE" && imagem) {
      await api(`/templates/${tid}/header`, { method: "PUT", body: { data: await lerBase64(imagem), mime: imagem.type, filename: imagem.name } });
    } else if (cabecalho === "NONE" && existente?.imagem && !existente.metaName) {
      await api(`/templates/${tid}/header`, { method: "DELETE" });
    }
    return tid;
  }

  async function acao(enviarMeta: boolean) {
    setBusy(true);
    setErro("");
    try {
      const tid = await salvar();
      if (enviarMeta) await api(`/templates/${tid}/submit`, { method: "POST" });
      navigate("/templates", { state: { aviso: enviarMeta ? `“${name}” foi enviado à Meta. A análise costuma levar de minutos a algumas horas; o status atualiza sozinho.` : `Rascunho de “${name}” salvo.` } });
    } catch (e) {
      setErro(textoErro(e));
    } finally {
      setBusy(false);
    }
  }

  if (carregando) return <p className="pd-hint">Carregando…</p>;
  if (id && !existente) {
    return (
      <div>
        <h2>Template</h2>
        <p className="error-text">{erro || "Template não encontrado."}</p>
        <Link className="btn secondary" to="/templates">Voltar</Link>
      </div>
    );
  }

  return (
    <div className="cw">
      <div className="cw-row" style={{ marginBottom: 6 }}>
        <Link className="btn secondary" to="/templates">← Voltar</Link>
        <div>
          <h2 style={{ margin: 0 }}>{id ? "Editar template" : "Novo template"}</h2>
          <p className="pd-sub">Crie seu template e envie pra aprovação.</p>
        </div>
      </div>

      <div className="cw-steps" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
        {STEPS.map((s, i) => (
          <button key={s} type="button" disabled={i > step} className={`cw-step ${i === step ? "active" : i < step ? "done" : ""}`} onClick={() => i < step && !busy && setStep(i)}>
            <span className="cw-step-n">{i < step ? "✓" : i + 1}</span>
            {s}
          </button>
        ))}
      </div>

      <div className="cw-grid">
        <div className="cw-main">
          {existente?.metaName && (
            <div className="card" style={{ borderLeft: "4px solid var(--warning)", fontSize: 13 }}>
              Este template já foi enviado à Meta. Mudar o conteúdo cria uma <strong>nova versão</strong>, que precisa de nova aprovação.
            </div>
          )}

          {step === 0 && (
            <div className="card">
              <h3>Nome e idioma do modelo</h3>
              <p className="pd-sub" style={{ marginBottom: 10 }}>Defina como o modelo será identificado.</p>
              <div className="seg-row">
                <div className="form-row">
                  <label>Nome</label>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: oferta_antecipacao" />
                  <span className="pd-hint">Só para você identificar. Na Meta vira letras minúsculas, números e _.</span>
                </div>
                <div className="form-row">
                  <label>Categoria</label>
                  <select value={category} onChange={(e) => setCategory(e.target.value as any)}>
                    <option value="MARKETING">Marketing (ofertas, reativação)</option>
                    <option value="UTILITY">Utilidade (avisos esperados)</option>
                  </select>
                  <span className="pd-hint">A Meta confere e pode reclassificar. Autenticação não é usada em campanhas.</span>
                </div>
                <div className="form-row">
                  <label>Idioma</label>
                  <select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={!!existente?.metaName}>
                    <option value="pt_BR">pt_BR (Português do Brasil)</option>
                    <option value="en_US">en_US (Inglês)</option>
                    <option value="es">es (Espanhol)</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="card">
              <h3>Conteúdo</h3>
              <p className="pd-sub" style={{ marginBottom: 12 }}>Adicione um cabeçalho, corpo de texto e rodapé. A Meta analisa variáveis e conteúdo antes da aprovação.</p>

              <div className="form-row">
                <label>Cabeçalho <span className="pd-hint" style={{ display: "inline" }}>· opcional</span></label>
                <select value={cabecalho} onChange={(e) => setCabecalho(e.target.value as any)}>
                  <option value="NONE">Nenhum</option>
                  <option value="IMAGE">Imagem</option>
                </select>
              </div>
              {cabecalho === "IMAGE" && (
                <div className="form-row">
                  <label>Mídia do cabeçalho</label>
                  <div className="cw-selected" style={{ marginTop: 0 }}>
                    <span>
                      {imagem ? imagem.name : existente?.imagem ? `${existente.imagem.filename} (já enviada)` : "Escolha um arquivo"}
                      <span className="pd-hint">Máximo: 3 MB. Formatos: PNG, JPEG.</span>
                    </span>
                    <label className="btn" style={{ cursor: "pointer" }}>
                      Escolher
                      <input type="file" accept="image/jpeg,image/png" style={{ display: "none" }} onChange={(e) => escolherImagem(e.target.files?.[0] ?? null)} />
                    </label>
                  </div>
                  <span className="pd-hint">Para enviar à Meta um template com imagem, informe o ID do app em Integrações → WhatsApp.</span>
                </div>
              )}

              <div className="form-row">
                <label>
                  Corpo <span style={{ float: "right" }}>{body.length}/{BODY_MAX}</span>
                </label>
                <div className="cw-editor">
                  <textarea ref={bodyRef} rows={6} value={body} maxLength={BODY_MAX} placeholder="Digite o corpo (obrigatório)" onChange={(e) => setBody(e.target.value)} />
                  <div className="cw-editor-bar">
                    <div className="cw-editor-fmt">
                      <button type="button" title="Negrito" onClick={() => envolver("*")}><b>B</b></button>
                      <button type="button" title="Itálico" onClick={() => envolver("_")}><i>I</i></button>
                      <button type="button" title="Riscado" onClick={() => envolver("~")}><s>S</s></button>
                      <button type="button" title="Código" onClick={() => envolver("```")}>{"</>"}</button>
                    </div>
                    <div style={{ position: "relative" }}>
                      <button type="button" className="cw-link" onClick={() => setMenuVar(!menuVar)}>+ Adicionar variável</button>
                      {menuVar && (
                        <div className="cw-menu">
                          {VARIAVEIS_NOSSAS.map((v) => (
                            <button key={v.key} type="button" onClick={() => inserirVariavel(v.key)}>
                              {v.label} <span className="pd-hint" style={{ display: "inline" }}>{`{{${v.key}}}`}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <span className="pd-hint">Não comece nem termine com variável, e não deixe duas coladas. Ofereça um jeito de recusar (ex.: um botão “SAIR”).</span>
              </div>

              <div className="form-row">
                <label>
                  Rodapé <span className="pd-hint" style={{ display: "inline" }}>· opcional</span>
                  {footer !== null && <span style={{ float: "right" }}>{footer.length}/{FOOTER_MAX}</span>}
                </label>
                {footer === null ? (
                  <div>
                    <button type="button" className="btn secondary" onClick={() => setFooter("")}>Adicionar rodapé</button>
                  </div>
                ) : (
                  <div className="cw-row">
                    <input className="cw-grow" maxLength={FOOTER_MAX} value={footer} onChange={(e) => setFooter(e.target.value)} placeholder="Ex.: Responda SAIR para não receber mais mensagens" />
                    <button type="button" className="btn secondary" onClick={() => setFooter(null)}>Remover</button>
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="card">
              <div className="cw-side-head">
                <div>
                  <h3 style={{ margin: 0 }}>Botões <span className="pd-hint" style={{ display: "inline" }}>· opcional</span></h3>
                  <p className="pd-sub">É possível adicionar até 10 botões. Se adicionar mais de 3, eles aparecem em lista.</p>
                </div>
                <div style={{ position: "relative" }}>
                  <button type="button" className="btn secondary" disabled={totalBotoes >= 10} onClick={() => setMenuBotao(!menuBotao)}>+ Adicionar botão ▾</button>
                  {menuBotao && (
                    <div className="cw-menu" style={{ right: 0, left: "auto", minWidth: 240 }}>
                      <div className="cw-box-title" style={{ padding: "4px 8px" }}>AÇÕES</div>
                      {(Object.keys(LIMITES) as BotaoTipo[]).map((t) => (
                        <button key={t} type="button" disabled={contagem(t) >= LIMITES[t].max} onClick={() => adicionar(t)}>
                          {LIMITES[t].label} <span className="pd-hint" style={{ display: "inline", float: "right" }}>{t === "QUICK_REPLY" ? "até" : "máx"} {LIMITES[t].max}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {botoes.length === 0 && <p className="pd-hint">Nenhum botão. Eles ajudam o cliente a responder ou a ir direto para a ação (site, ligação).</p>}

              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
                {botoes.map((b, i) => (
                  <div key={b.key} className="cw-btn-row">
                    <div className="cw-btn-head">
                      <span className="badge">{LIMITES[b.tipo].label}</span>
                      <span style={{ flex: 1 }} />
                      <button type="button" className="btn secondary" disabled={i === 0} onClick={() => mover(b.key, -1)} aria-label="Subir">↑</button>
                      <button type="button" className="btn secondary" disabled={i === botoes.length - 1} onClick={() => mover(b.key, 1)} aria-label="Descer">↓</button>
                      <button type="button" className="btn secondary" onClick={() => remover(b.key)}>Remover</button>
                    </div>
                    <div className="seg-row">
                      <div className="form-row">
                        <label>Texto do botão</label>
                        <input value={b.text} maxLength={BTN_TEXT_MAX} onChange={(e) => atualizar(b.key, { text: e.target.value })} placeholder={b.tipo === "URL" ? "Ex.: Abrir o app" : b.tipo === "PHONE_NUMBER" ? "Ex.: Ligar" : "Ex.: Quero saber mais"} />
                        <span className="pd-hint">{b.text.length}/{BTN_TEXT_MAX}{b.tipo === "QUICK_REPLY" && b.text.trim().toLowerCase() === "sair" ? " · quem toca é descadastrado automaticamente" : ""}</span>
                      </div>
                      {b.tipo === "URL" && (
                        <div className="form-row">
                          <label>Link do site (destino)</label>
                          <input value={b.url} onChange={(e) => atualizar(b.key, { url: e.target.value })} placeholder="https://" inputMode="url" />
                          <span className="pd-hint">Link fixo: todos recebem o mesmo destino.</span>
                        </div>
                      )}
                      {b.tipo === "PHONE_NUMBER" && (
                        <div className="form-row">
                          <label>Telefone</label>
                          <input value={b.phone} onChange={(e) => atualizar(b.key, { phone: e.target.value })} placeholder="(84) 99999-8888" inputMode="tel" />
                          <span className="pd-hint">Com DDD. Sem código do país, assumimos +55.</span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <p className="pd-hint" style={{ marginTop: 10 }}>Regras: até 2 botões de link, 1 de ligar; as respostas rápidas ficam agrupadas, antes dos botões de link e ligação.</p>
              {problemasBotoes.map((p) => (
                <p key={p} className="pd-hint" style={{ color: "var(--warning)" }}>{p}</p>
              ))}
            </div>
          )}

          {erro && <p className="error-text">{erro}</p>}

          <div className="card cw-footer">
            <button type="button" className="btn secondary" disabled={busy || step === 0} onClick={() => setStep(step - 1)}>Voltar</button>
            <span className="cw-footer-mid">{step === 1 && motivoPasso1 ? motivoPasso1 : step === 2 && !passo2Ok ? "Revise as regras dos botões" : ""}</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="btn secondary" disabled={busy || !passo0Ok || body.trim() === ""} onClick={() => acao(false)}>Salvar rascunho</button>
              {step < 2 ? (
                <button type="button" className="btn" disabled={!podeContinuar || busy} onClick={() => setStep(step + 1)}>Continuar</button>
              ) : metaOk ? (
                <button type="button" className="btn" disabled={!podeContinuar || busy} onClick={() => acao(true)}>Enviar pra Meta</button>
              ) : (
                <button type="button" className="btn" disabled={!podeContinuar || busy} onClick={() => acao(false)}>Salvar</button>
              )}
            </div>
          </div>
          {step === 2 && !metaOk && <p className="pd-hint">A Meta ainda não está conectada em Integrações → WhatsApp: o template fica como rascunho.</p>}
        </div>

        <aside className="cw-side">
          <div className="card">
            <div className="cw-side-head"><span className="cw-label">PRÉVIA DO MODELO</span></div>
            <TemplatePreview template={preview} ctx={SAMPLE_CTX} imageUrl={imagemUrl} />
          </div>
        </aside>
      </div>
    </div>
  );
}

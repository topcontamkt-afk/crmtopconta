import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";
import CostsModal from "../../components/campaign/CostsModal";
import FiltrosRapidos, { FILTROS_VAZIOS, Filtros, filtrosParaApi } from "../../components/campaign/FiltrosRapidos";
import PlanilhaAudience from "../../components/campaign/PlanilhaAudience";
import TemplatePreview from "../../components/campaign/TemplatePreview";
import VariableMapEditor from "../../components/campaign/VariableMapEditor";
import { brl, PlanilhaRow, SAMPLE_CTX, Validation, WaTemplate } from "../../components/campaign/types";

const STEPS = ["Configuração", "Público", "Validação", "Agendamento"];

type Publico = "todos" | "segmentos" | "planilha" | "teste" | "lista";

interface Segment {
  id: string;
  name: string;
  lastCount: number | null;
}

interface CampaignLite {
  id: string;
  templateId: string | null;
  createdAt: string;
}

interface PresetState {
  presetClientIds?: string[];
  presetLabel?: string;
  presetTemplateId?: string; // vindo da tela de Templates ("Usar em campanha")
}

const PUBLICO_LABEL: Record<Publico, string> = {
  todos: "Todos os elegíveis",
  segmentos: "Segmento / filtros",
  planilha: "Planilha",
  teste: "Teste",
  lista: "Lista pré-selecionada",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function textoErro(e: unknown): string {
  const m = e instanceof Error ? e.message : "Erro inesperado";
  try {
    const v = JSON.parse(m);
    if (typeof v === "string") return v;
    if (v?.formErrors?.length) return v.formErrors.join(" ");
    return m;
  } catch {
    return m;
  }
}

export default function CampaignWizard() {
  const navigate = useNavigate();
  const location = useLocation();
  const [search] = useSearchParams();
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  const preset = (location.state as PresetState | null) || null;

  const [step, setStep] = useState(0);
  const [nome, setNome] = useState(`Campanha ${new Date().toLocaleDateString("pt-BR", { day: "numeric", month: "short" }).replace(".", "")}`);
  const [catFiltro, setCatFiltro] = useState<"" | "MARKETING" | "UTILITY">("");

  // templates
  const [templates, setTemplates] = useState<WaTemplate[]>([]);
  const [metaConectada, setMetaConectada] = useState(true);
  const [sincronizando, setSincronizando] = useState(true);
  const [recentes, setRecentes] = useState<string[]>([]);
  const [templateId, setTemplateId] = useState(preset?.presetTemplateId ?? "");
  const [busca, setBusca] = useState("");
  const [verTodos, setVerTodos] = useState(false);

  // público
  const inicial: Publico = preset?.presetClientIds?.length ? "lista" : search.get("publico") === "planilha" ? "planilha" : "todos";
  const [publico, setPublico] = useState<Publico>(inicial);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [segmentId, setSegmentId] = useState("");
  const [filtros, setFiltros] = useState<Filtros>(FILTROS_VAZIOS);
  const [rows, setRows] = useState<PlanilhaRow[]>([]);
  const [consent, setConsent] = useState(false);
  // LGPD 02-02: origem do consentimento de quem NÃO é cliente (onde e como foi coletado)
  const [consentOrigem, setConsentOrigem] = useState("");
  const [telefonesTeste, setTelefonesTeste] = useState("");
  const [testeMsg, setTesteMsg] = useState<string | null>(null);
  const testeCampaign = useRef<string | null>(null);

  // validação / custo
  const [validation, setValidation] = useState<(Validation & { foraDaBase?: number }) | null>(null);
  const [validando, setValidando] = useState(false);
  const [erroValidacao, setErroValidacao] = useState("");
  const [custosAberto, setCustosAberto] = useState(false);
  const [custoTick, setCustoTick] = useState(0);

  // avançado
  const [controle, setControle] = useState(0);
  const [throttle, setThrottle] = useState(60);

  // agendamento
  const [quando, setQuando] = useState<"agora" | "agendar">("agora");
  const [dataAg, setDataAg] = useState("");
  const [horaAg, setHoraAg] = useState("09:00");

  // envio
  const [erro, setErro] = useState("");
  const [busy, setBusy] = useState(false);
  const [progresso, setProgresso] = useState<{ fase: string; enviados: number; total: number; aviso?: string } | null>(null);
  const cancelar = useRef(false);

  /* ───────── templates (sincroniza com a Meta e traz os aprovados) ───────── */
  function carregarTemplates() {
    return api<WaTemplate[]>("/templates?channel=WHATSAPP&status=APROVADO").then(setTemplates);
  }
  useEffect(() => {
    api<{ configurado: boolean }>("/templates/meta-status").then((m) => setMetaConectada(m.configurado)).catch(() => {});
    // Mostra já o que está no cadastro e depois traz o que a sincronização achar de novo na Meta
    // (a 1ª sincronização importa um template por vez e pode levar minutos: a lista não pode esperar por ela).
    carregarTemplates().catch(() => undefined);
    api("/templates/sync", { method: "POST" })
      .catch(() => undefined)
      .finally(() => {
        carregarTemplates().finally(() => setSincronizando(false));
      });
    api<CampaignLite[]>("/campaigns")
      .then((cs) => {
        const seen: string[] = [];
        for (const c of [...cs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) if (c.templateId && !seen.includes(c.templateId)) seen.push(c.templateId);
        setRecentes(seen);
      })
      .catch(() => {});
    api<Segment[]>("/segments").then(setSegments).catch(() => {});
  }, []);

  const usavel = (t: WaTemplate) => !t.sendIssue && (!metaConectada || t.metaStatus === "APPROVED");
  const doTipo = (t: WaTemplate) => !catFiltro || t.category === catFiltro;
  const template = templates.find((t) => t.id === templateId) ?? null;

  const lista = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return templates.filter((t) => doTipo(t) && (!q || t.name.toLowerCase().includes(q)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates, busca, catFiltro]);
  const recentesLista = recentes.map((id) => lista.find((t) => t.id === id)).filter((t): t is WaTemplate => !!t && usavel(t)).slice(0, 3);
  const recomendados = lista
    .filter((t) => usavel(t) && !recentesLista.some((r) => r.id === t.id))
    .sort((a, b) => (b.qualityScore === "GREEN" ? 1 : 0) - (a.qualityScore === "GREEN" ? 1 : 0) || a.name.localeCompare(b.name))
    .slice(0, 3);
  const buscando = busca.trim() !== "";

  /* ───────── público → corpo da validação ───────── */
  const filtrosApi = useMemo(() => filtrosParaApi(filtros), [filtros]);
  const temFiltro = Object.values(filtrosApi).some((v) => v !== undefined);
  const audiencia = useMemo(() => {
    if (publico === "todos") return { tipo: "todos" as const };
    if (publico === "lista") return { tipo: "lista" as const, clientIds: preset?.presetClientIds ?? [] };
    if (publico === "planilha") return rows.length ? { tipo: "planilha" as const, rows } : null;
    if (publico === "segmentos") {
      if (segmentId) return { tipo: "segmento" as const, segmentId };
      return temFiltro ? { tipo: "filtros" as const, filters: filtrosApi } : null;
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publico, rows, segmentId, filtrosApi, temFiltro]);

  const agendadoPara = quando === "agendar" && dataAg ? new Date(`${dataAg}T${horaAg || "09:00"}:00`) : null;

  const validar = step >= 1;
  useEffect(() => {
    if (!templateId || !audiencia || !validar) {
      setValidation(null);
      return;
    }
    let vivo = true;
    setValidando(true);
    setErroValidacao("");
    const t = setTimeout(() => {
      api<Validation>("/campaigns/wizard/validar", {
        method: "POST",
        body: { templateId, audience: audiencia, scheduledAt: agendadoPara ? agendadoPara.toISOString() : undefined },
      })
        .then((v) => vivo && setValidation(v))
        .catch((e) => vivo && (setValidation(null), setErroValidacao(textoErro(e))))
        .finally(() => vivo && setValidando(false));
    }, 500);
    return () => {
      vivo = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, audiencia, validar, custoTick, dataAg, horaAg, quando, template?.variableMap]);

  /* ───────── contexto do preview ───────── */
  const ctxPreview = useMemo(() => {
    if (publico === "planilha" && rows.length) {
      const l = rows[0].limiteDisponivel.trim();
      const val = l ? (/^R\$/i.test(l) ? l : `R$ ${l}`) : SAMPLE_CTX.limite_disponivel;
      return { ...SAMPLE_CTX, nome: rows[0].nome.split(" ")[0] || SAMPLE_CTX.nome, limite_disponivel: val, saldo: val };
    }
    return SAMPLE_CTX;
  }, [publico, rows]);

  /* ───────── navegação entre passos ───────── */
  const faltamVariaveis = (template?.variaveisSemMapa?.length ?? 0) > 0;
  const passo0Ok = nome.trim() !== "" && !!template && usavel(template) && !faltamVariaveis;
  const passo1Ok = publico !== "teste" && !!audiencia && !!validation && validation.contatos > 0;
  const foraDaBase = publico === "planilha" ? validation?.foraDaBase ?? 0 : 0;
  const passo2Ok = !!validation?.podeLancar && (publico !== "planilha" || (consent && (foraDaBase === 0 || consentOrigem.trim().length >= 10)));
  const passo3Ok = quando === "agora" || (!!agendadoPara && agendadoPara.getTime() > Date.now());
  const podeContinuar = [passo0Ok, passo1Ok, passo2Ok, passo3Ok][step];

  /* ───────── teste ───────── */
  async function enviarTeste() {
    if (!template) return;
    setBusy(true);
    setTesteMsg(null);
    setErro("");
    try {
      const phones = telefonesTeste
        .split(/[,;\n]/)
        .map((p) => p.replace(/\D/g, ""))
        .filter(Boolean)
        .map((p) => (p.length <= 11 ? `55${p}` : p));
      if (!phones.length) throw new Error("Informe ao menos um telefone (com DDD).");
      if (!testeCampaign.current) {
        const c = await api<{ id: string }>("/campaigns", {
          method: "POST",
          body: { name: `Teste ${nome}`.slice(0, 120), channel: "WHATSAPP", templateId: template.id, isSandbox: true, adHocFilters: {} },
        });
        testeCampaign.current = c.id;
      }
      const r = await api<{ results: { phone: string; status: string; error?: string }[] }>(`/campaigns/${testeCampaign.current}/test-send`, { method: "POST", body: { phones } });
      setTesteMsg(r.results.map((x) => `${x.phone}: ${x.status === "SENT" ? "enviado" : `falhou${x.error ? ` (${x.error})` : ""}`}`).join(" · "));
    } catch (e) {
      setErro(textoErro(e));
    } finally {
      setBusy(false);
    }
  }

  /* ───────── criar / lançar ───────── */
  async function criarCampanha(rascunho: boolean): Promise<{ id: string; total: number }> {
    const custo = validation?.custo.brl ?? 0;
    const scheduledAt = quando === "agendar" && agendadoPara ? agendadoPara.toISOString() : undefined;
    if (publico === "planilha") {
      const r = await api<{ campaign: { id: string }; enviar: number }>("/campaigns/manual", {
        method: "POST",
        body: {
          name: nome.trim(),
          templateId,
          rows,
          consentimento: true,
          ...(foraDaBase > 0 ? { consentimentoOrigem: consentOrigem.trim() } : {}),
          rascunho,
          scheduledAt,
          costPerMessage: custo,
          throttlePerMin: throttle,
        },
      });
      return { id: r.campaign.id, total: r.enviar };
    }
    const c = await api<{ id: string; audienceCount: number | null }>("/campaigns", {
      method: "POST",
      body: {
        name: nome.trim(),
        channel: "WHATSAPP",
        templateId,
        segmentId: publico === "segmentos" && segmentId ? segmentId : undefined,
        adHocFilters: publico === "lista" ? { clientIds: preset?.presetClientIds } : publico === "todos" ? {} : segmentId ? undefined : filtrosApi,
        scheduledAt,
        costPerMessage: custo,
        throttlePerMin: throttle,
        controlGroupPercent: controle > 0 ? controle : undefined,
      },
    });
    return { id: c.id, total: c.audienceCount ?? validation?.contatos ?? 0 };
  }

  async function salvarRascunho() {
    setBusy(true);
    setErro("");
    try {
      await criarCampanha(true);
      navigate("/campaigns");
    } catch (e) {
      setErro(textoErro(e));
    } finally {
      setBusy(false);
    }
  }

  async function lancar() {
    setBusy(true);
    setErro("");
    cancelar.current = false;
    try {
      setProgresso({ fase: "Criando a campanha…", enviados: 0, total: validation?.contatos ?? 0 });
      const { id } = await criarCampanha(false);
      await api(`/campaigns/${id}/schedule`, { method: "POST" });

      if (quando === "agendar") {
        navigate(`/campaigns/${id}/report`);
        return;
      }
      // Imediato: o relatório da campanha roda o envio em lotes e mostra o funil ao vivo.
      navigate(`/campaigns/${id}/report?enviar=1`);
    } catch (e) {
      setProgresso(null);
      setErro(textoErro(e));
      setBusy(false);
    }
  }

  const custo = validation?.custo;
  const contatos = validation?.contatos;

  return (
    <div className="cw">
      <div className="pd-sub" style={{ marginBottom: 6 }}>
        <Link to="/campaigns">Campanhas</Link> / Novo
      </div>
      <h2 style={{ margin: 0 }}>Criar campanha</h2>
      <p className="pd-sub">Uma decisão por vez, com o resumo sempre visível.</p>

      <div className="cw-steps">
        {STEPS.map((s, i) => (
          <button
            key={s}
            type="button"
            disabled={i > step}
            className={`cw-step ${i === step ? "active" : i < step ? "done" : ""}`}
            onClick={() => i < step && !busy && setStep(i)}
          >
            <span className="cw-step-n">{i < step ? "✓" : i + 1}</span>
            {s}
          </button>
        ))}
      </div>

      <div className="cw-grid">
        <div className="cw-main">
          {step === 0 && (
            <>
              <div className="card">
                <div className="cw-row">
                  <input className="cw-grow" value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Nome da campanha" aria-label="Nome da campanha" />
                  <select value={catFiltro} onChange={(e) => setCatFiltro(e.target.value as any)} aria-label="Categoria">
                    <option value="">Todos</option>
                    <option value="MARKETING">Marketing</option>
                    <option value="UTILITY">Utilidade</option>
                  </select>
                </div>
              </div>

              <div className="card">
                <h3>Template</h3>
                <p className="pd-sub" style={{ marginBottom: 10 }}>
                  Busque e escolha o template da campanha. Só aparecem os aprovados pela Meta{sincronizando ? " (sincronizando com a Meta…)" : ""}.
                </p>
                <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Digite o nome do template..." aria-label="Buscar template" />

                {template && !buscando && (
                  <div className="cw-selected">
                    <span>✓ <strong>{template.name}</strong> <span className="badge">{template.category === "UTILITY" ? "UTILIDADE" : "MARKETING"}</span></span>
                    <button type="button" className="btn secondary" onClick={() => setTemplateId("")}>Trocar</button>
                  </div>
                )}

                {(!template || buscando) && !verTodos && !buscando && (
                  <div className="cw-cols">
                    <div className="cw-box">
                      <div className="cw-box-title">Recentes</div>
                      {recentesLista.length === 0 && <span className="pd-hint">Nenhuma campanha anterior.</span>}
                      {recentesLista.map((t) => <TemplateItem key={t.id} t={t} onPick={() => setTemplateId(t.id)} />)}
                    </div>
                    <div className="cw-box">
                      <div className="cw-box-title">Recomendados</div>
                      {recomendados.length === 0 && <span className="pd-hint">{sincronizando ? "Carregando…" : "Nenhum template aprovado ainda."}</span>}
                      {recomendados.map((t) => <TemplateItem key={t.id} t={t} onPick={() => setTemplateId(t.id)} />)}
                    </div>
                  </div>
                )}

                {(!template || buscando) && (verTodos || buscando) && (
                  <div className="cw-box" style={{ marginTop: 10 }}>
                    {lista.length === 0 && <span className="pd-hint">{sincronizando ? "Sincronizando com a Meta… os templates novos aparecem aqui quando terminar." : "Nenhum template encontrado."}</span>}
                    {lista.map((t) => <TemplateItem key={t.id} t={t} bloqueado={!usavel(t)} onPick={() => { setTemplateId(t.id); setBusca(""); }} />)}
                  </div>
                )}

                {!template && !buscando && (
                  <button type="button" className="btn secondary" style={{ marginTop: 10 }} onClick={() => setVerTodos(!verTodos)}>
                    {verTodos ? "Ver menos" : "Ver todos os templates"}
                  </button>
                )}

                {template && !usavel(template) && <p className="error-text">Este template não pode ser enviado: {template.sendIssue || "ainda não foi aprovado pela Meta."}</p>}
                {template && <VariableMapEditor key={template.id + (template.variableMap ?? []).join()} template={template} onSaved={(t) => setTemplates((arr) => arr.map((x) => (x.id === t.id ? { ...x, ...t } : x)))} />}
              </div>
              <p className="pd-hint">
                Precisa de SMS, texto livre ou teste A/B? Use o <Link to="/campaigns/classic">assistente clássico</Link>.
              </p>
            </>
          )}

          {step === 1 && (
            <>
              <div className="card">
                <h3>Escolha o público</h3>
                <p className="pd-sub" style={{ marginBottom: 10 }}>Quem recebe: a base do sistema ou uma planilha que você sobe agora.</p>
                <div className="cw-cards">
                  {preset?.presetClientIds?.length ? (
                    <PublicoCard ativo={publico === "lista"} titulo="Lista pré-selecionada" sub={`${preset.presetLabel ?? "Público escolhido"} · ${preset.presetClientIds.length} clientes`} onClick={() => setPublico("lista")} />
                  ) : null}
                  <PublicoCard ativo={publico === "todos"} titulo="Todos" sub="Clientes elegíveis da base" onClick={() => setPublico("todos")} />
                  <PublicoCard ativo={publico === "segmentos"} titulo="Segmentos" sub="Segmento salvo ou filtros rápidos" onClick={() => setPublico("segmentos")} />
                  <PublicoCard ativo={publico === "planilha"} titulo="Planilha" sub="Subir .xlsx/.csv com nome e telefone" onClick={() => setPublico("planilha")} />
                  <PublicoCard ativo={publico === "teste"} titulo="Teste" sub="Enviar para o seu número" onClick={() => setPublico("teste")} />
                </div>
              </div>

              {publico === "segmentos" && (
                <div className="card">
                  <h3>Segmentos rápidos</h3>
                  <div className="form-row">
                    <label>Segmento salvo</label>
                    <select value={segmentId} onChange={(e) => setSegmentId(e.target.value)}>
                      <option value="">— Montar com filtros —</option>
                      {segments.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}{s.lastCount !== null ? ` (${s.lastCount})` : ""}</option>
                      ))}
                    </select>
                  </div>
                  {!segmentId && <FiltrosRapidos value={filtros} onChange={setFiltros} />}
                  {!segmentId && !temFiltro && <p className="pd-hint" style={{ marginTop: 8 }}>Escolha ao menos um filtro, ou use o cartão "Todos".</p>}
                </div>
              )}

              {publico === "planilha" && (
                <div className="card">
                  <h3>Planilha</h3>
                  <PlanilhaAudience onRows={(r) => setRows(r)} />
                </div>
              )}

              {publico === "teste" && (
                <div className="card">
                  <h3>Enviar um teste</h3>
                  <p className="pd-hint" style={{ marginBottom: 8 }}>Manda o template, com dados de exemplo, para os números abaixo. Não cria campanha real nem entra nos relatórios.</p>
                  <div className="cw-row">
                    <input className="cw-grow" value={telefonesTeste} onChange={(e) => setTelefonesTeste(e.target.value)} placeholder="Telefones com DDD, separados por vírgula" />
                    <button type="button" className="btn" disabled={busy || !template} onClick={enviarTeste}>Enviar teste</button>
                  </div>
                  {testeMsg && <p style={{ fontSize: 13, marginTop: 8 }}>{testeMsg}</p>}
                </div>
              )}

              {publico !== "teste" && audiencia && (
                <p style={{ fontSize: 14 }}>
                  {validando ? "Contando…" : validation ? <><strong>{validation.contatos}</strong> contatos elegíveis{validation.total > validation.contatos ? ` (de ${validation.total}; opt-out, bloqueados e sem limite ficam de fora)` : ""}</> : erroValidacao ? <span className="error-text">{erroValidacao}</span> : null}
                </p>
              )}
            </>
          )}

          {step === 2 && (
            <div className="card">
              <h3>Validação</h3>
              <p className="pd-sub" style={{ marginBottom: 10 }}>Confira antes de lançar. Itens em vermelho impedem o envio.</p>
              {validando && <p className="pd-hint">Conferindo…</p>}
              {erroValidacao && <p className="error-text">{erroValidacao}</p>}
              <ul className="cw-checks">
                {validation?.checks.map((c) => (
                  <li key={c.id} className={`cw-check ${c.nivel}`}>
                    <span className="cw-check-ic">{c.nivel === "ok" ? "✓" : c.nivel === "aviso" ? "!" : "✕"}</span>
                    <div>
                      <strong>{c.titulo}</strong>
                      {c.detalhe && <div className="pd-hint">{c.detalhe}</div>}
                    </div>
                  </li>
                ))}
              </ul>

              {validation && validation.motivos.length > 0 && (
                <details style={{ marginTop: 8 }}>
                  <summary>Ver linhas recusadas</summary>
                  <ul style={{ fontSize: 13 }}>
                    {validation.motivos.map((m, i) => <li key={i}>Linha {m.linha + 1}: {m.motivo}</li>)}
                  </ul>
                </details>
              )}

              {publico === "planilha" && (
                <label className="cw-consent">
                  <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                  <span>Confirmo que tenho autorização para contatar estes números pelo WhatsApp. Quem já pediu para não receber mensagens foi retirado da lista automaticamente.</span>
                </label>
              )}
              {publico === "planilha" && foraDaBase > 0 && (
                <div className="form-row" style={{ marginTop: 10 }}>
                  <label>
                    Origem do consentimento dos {foraDaBase} contato(s) que não são clientes <span className="error-text">(obrigatório)</span>
                  </label>
                  <textarea
                    rows={2}
                    value={consentOrigem}
                    onChange={(e) => setConsentOrigem(e.target.value)}
                    maxLength={1000}
                    placeholder="Onde e como o aceite foi coletado. Ex.: formulário do site em out/2026, com caixa de aceite para receber ofertas pelo WhatsApp"
                  />
                  <div className="pd-hint">
                    Quem não é cliente não tem relação com a empresa: a mensagem só pode ir com consentimento. A origem fica gravada na campanha, com o
                    seu usuário e a data (LGPD).
                  </div>
                </div>
              )}

              {publico !== "planilha" && publico !== "teste" && (
                <details style={{ marginTop: 12 }}>
                  <summary>Avançado</summary>
                  <div className="seg-row" style={{ marginTop: 8 }}>
                    <div className="form-row">
                      <label>Grupo de controle (% do público que NÃO recebe, para medir o ganho real)</label>
                      <input type="number" min={0} max={50} value={controle} onChange={(e) => setControle(Math.max(0, Math.min(50, Number(e.target.value) || 0)))} />
                    </div>
                    <div className="form-row">
                      <label>Envios por minuto (no máximo)</label>
                      <input type="number" min={1} value={throttle} onChange={(e) => setThrottle(Math.max(1, Number(e.target.value) || 60))} />
                    </div>
                  </div>
                </details>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="card">
              <h3>Agendamento</h3>
              <p className="pd-sub" style={{ marginBottom: 10 }}>Defina se o envio será agora ou programado.</p>
              <div className="cw-cards" style={{ gridTemplateColumns: "1fr 1fr" }}>
                <PublicoCard ativo={quando === "agora"} titulo="Imediato" sub="Envia agora, com esta tela aberta" onClick={() => setQuando("agora")} />
                <PublicoCard ativo={quando === "agendar"} titulo="Agendar" sub="Escolher data e horário" onClick={() => setQuando("agendar")} />
              </div>
              {quando === "agendar" && (
                <>
                  <div className="seg-row" style={{ marginTop: 12 }}>
                    <div className="form-row">
                      <label>Data</label>
                      <input type="date" value={dataAg} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setDataAg(e.target.value)} />
                    </div>
                    <div className="form-row">
                      <label>Horário</label>
                      <input type="time" value={horaAg} onChange={(e) => setHoraAg(e.target.value)} />
                    </div>
                  </div>
                  <p className="pd-hint">
                    Fuso do navegador: {Intl.DateTimeFormat().resolvedOptions().timeZone}. No plano atual o envio automático roda uma vez por dia (por volta das 06h de Brasília): a campanha sai nesse ciclo,
                    depois do horário marcado. Para enviar na hora, use "Imediato".
                  </p>
                </>
              )}
            </div>
          )}

          {erro && <p className="error-text">{erro}</p>}

          <div className="card cw-footer">
            <button type="button" className="btn secondary" disabled={busy || step === 0} onClick={() => setStep(step - 1)}>Voltar</button>
            <span className="cw-footer-mid">
              {step === 0 ? (template ? template.name : "Selecione um template para continuar") : contatos !== undefined ? `${contatos} contatos${custo?.total != null ? ` • ${brl(custo.total)}` : ""}` : publico === "teste" ? "Teste" : ""}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              {step === 3 && (
                <button type="button" className="btn secondary" disabled={busy} onClick={salvarRascunho}>Salvar rascunho</button>
              )}
              {step < 3 ? (
                <button type="button" className="btn" disabled={!podeContinuar || busy || (step === 1 && publico === "teste")} onClick={() => setStep(step + 1)}>Continuar</button>
              ) : (
                <button type="button" className="btn" disabled={!podeContinuar || busy} onClick={lancar}>{quando === "agendar" ? "Agendar campanha" : "Lançar campanha"}</button>
              )}
            </div>
          </div>
        </div>

        <aside className="cw-side">
          <div className="card">
            <div className="cw-side-head">
              <span className="cw-label">RESUMO</span>
              {template && <span className="badge ok">{template.category === "UTILITY" ? "Utilidade" : "Marketing"}</span>}
            </div>
            {contatos !== undefined && <ResumoLinha k="Contatos" v={String(contatos)} />}
            {custo?.total != null && <ResumoLinha k="Custo" v={brl(custo.total)} destaque />}
            <ResumoLinha
              k="Custo base"
              v={custo?.brl != null ? `${brl(custo.brl, 2)}/msg` : "R$ --/msg"}
              sub={custo?.categoria ? `${custo.categoria} · USD/BRL ${custo.cambio.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}` : undefined}
              destaque
            />
            <ResumoLinha k="Agendamento" v={quando === "agendar" && agendadoPara ? agendadoPara.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : step >= 3 ? "Imediato" : "A definir"} />
            <ResumoLinha k="Nome" v={nome || "—"} />
            <ResumoLinha k="Template" v={template?.name ?? "—"} />
            {step >= 1 && <ResumoLinha k="Público" v={contatos !== undefined ? `${contatos} contatos` : PUBLICO_LABEL[publico]} />}
            {isAdmin && (
              <button type="button" className="cw-link" onClick={() => setCustosAberto(true)}>Configurar custos</button>
            )}
          </div>
          <div className="card">
            <div className="cw-side-head">
              <span className="cw-label">PREVIEW</span>
            </div>
            <TemplatePreview template={template} ctx={ctxPreview} />
          </div>
        </aside>
      </div>

      {custosAberto && <CostsModal onClose={() => setCustosAberto(false)} onSaved={() => setCustoTick((n) => n + 1)} />}

      {progresso && (
        <div className="dsb-palette-overlay">
          <div className="card" style={{ maxWidth: 420, width: "92%", margin: "20vh auto" }}>
            <h3>{progresso.fase}</h3>
            {progresso.total > 0 && (
              <>
                <div className="progress-track"><div className="progress-fill" style={{ width: `${Math.min(100, (progresso.enviados / progresso.total) * 100)}%` }} /></div>
                <p style={{ fontSize: 13 }}>{progresso.enviados} de {progresso.total}</p>
              </>
            )}
            {progresso.aviso ? (
              <>
                <p className="error-text">{progresso.aviso}</p>
                <button className="btn secondary" onClick={() => setProgresso(null)}>Fechar</button>
              </>
            ) : (
              <>
                <p className="pd-hint">Mantenha esta tela aberta até terminar. O que não sair agora segue no ciclo diário.</p>
                <button className="btn secondary" onClick={() => { cancelar.current = true; }}>Parar e ver o relatório</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TemplateItem({ t, onPick, bloqueado }: { t: WaTemplate; onPick: () => void; bloqueado?: boolean }) {
  return (
    <button type="button" className="cw-item" disabled={bloqueado} onClick={onPick} title={bloqueado ? t.sendIssue || "Ainda não aprovado pela Meta" : undefined}>
      <strong>{t.name}</strong>
      <span className="pd-hint">
        {t.category === "UTILITY" ? "UTILIDADE" : "MARKETING"}
        {t.origin === "META" ? " · da Meta" : ""}
        {bloqueado ? ` · ${t.sendIssue ? "formato não suportado" : "não aprovado"}` : ""}
      </span>
    </button>
  );
}

function PublicoCard({ ativo, titulo, sub, onClick }: { ativo: boolean; titulo: string; sub: string; onClick: () => void }) {
  return (
    <button type="button" className={`cw-card ${ativo ? "active" : ""}`} onClick={onClick}>
      <strong>{titulo}</strong>
      <span className="pd-hint">{sub}</span>
    </button>
  );
}

function ResumoLinha({ k, v, sub, destaque }: { k: string; v: string; sub?: string; destaque?: boolean }) {
  return (
    <div className="cw-kv">
      <span>{k}</span>
      <span style={{ textAlign: "right" }}>
        <span style={destaque ? { color: "var(--success)" } : undefined}>{v}</span>
        {sub && <span className="pd-hint" style={{ textAlign: "right" }}>{sub}</span>}
      </span>
    </div>
  );
}

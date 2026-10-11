import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { FAIXA_OPTIONS } from "../utils/faixas";

interface Segment {
  id: string;
  name: string;
  lastCount: number | null;
  dynamic: boolean;
  lastRefreshedAt: string | null;
  createdAt: string;
}

const STATUS_OPTIONS = [
  { value: "ATIVO", label: "Ativo" },
  { value: "INATIVO", label: "Inativo" },
  { value: "BLOQUEADO", label: "Bloqueado" },
];

const ETAPA_OPTIONS = [
  { value: "NUNCA_USOU", label: "Nunca usou" },
  { value: "RECORRENTE", label: "Recorrente (3+ usos em 90 dias)" },
  { value: "OCASIONAL", label: "Ocasional (1–2 usos)" },
  { value: "EM_RISCO", label: "Em risco (31–90 dias sem uso)" },
  { value: "INATIVO", label: "Inativo (+90 dias sem uso)" },
];

const PERFIL_OPTIONS = [
  { value: "PF1", label: "PF1 · até R$ 4.000" },
  { value: "PF2", label: "PF2 · 4.001 a 8.000" },
  { value: "PF3", label: "PF3 · 8.001 a 12.000" },
  { value: "PF4", label: "PF4 · 12.001 a 100.000" },
];

/** Grupo de opções em "chips" (várias marcadas = qualquer uma delas, ou seja, OU). */
function Chips({ options, value, onChange }: { options: { value: string; label: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="chip-group">
      {options.map((o) => (
        <label key={o.value} className="chip">
          <input
            type="checkbox"
            checked={value.includes(o.value)}
            onChange={() => onChange(value.includes(o.value) ? value.filter((v) => v !== o.value) : [...value, o.value])}
          />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

function Section({ title, count, defaultOpen = false, children }: { title: string; count: number; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <details className="seg-section" open={defaultOpen || count > 0}>
      <summary>
        {title}
        {count > 0 && <span className="seg-badge">{count} filtro{count > 1 ? "s" : ""}</span>}
      </summary>
      {children}
    </details>
  );
}

export default function Segments() {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [name, setName] = useState("");
  const [dynamic, setDynamic] = useState(true);
  const [cidade, setCidade] = useState("");
  const [perfilRenda, setPerfilRenda] = useState<string[]>([]);
  const [statusConta, setStatusConta] = useState<string[]>([]);
  const [tags, setTags] = useState("");
  const [faixaUso, setFaixaUso] = useState<string[]>([]);
  const [semUsoDiasMin, setSemUsoDiasMin] = useState("");
  const [usadoNosUltimosDias, setUsadoNosUltimosDias] = useState("");
  const [etapaUso, setEtapaUso] = useState<string[]>([]);
  const [usosMin, setUsosMin] = useState("");
  const [diasSemUsoRealMin, setDiasSemUsoRealMin] = useState("");
  const [categoriasCompra, setCategoriasCompra] = useState<string[]>([]);
  const [compraNosUltimosDias, setCompraNosUltimosDias] = useState("");
  const [categoriasDisponiveis, setCategoriasDisponiveis] = useState<{ key: string; label: string }[]>([]);
  const [preview, setPreview] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);
  const [busy, setBusy] = useState(false);

  function load() {
    api<Segment[]>("/segments").then(setSegments);
  }
  useEffect(load, []);
  useEffect(() => {
    api<{ todasCategorias: { key: string; label: string }[] }>("/purchases/categories")
      .then((r) => setCategoriasDisponiveis(r.todasCategorias))
      .catch(() => {});
  }, []);

  const filters = useMemo(
    () => ({
      cidade: cidade.trim() ? [cidade.trim()] : undefined,
      faixaUso: faixaUso.length ? faixaUso : undefined,
      statusConta: statusConta.length ? statusConta : undefined,
      perfilRenda: perfilRenda.length ? perfilRenda : undefined,
      etapaUso: etapaUso.length ? etapaUso : undefined,
      usosMin: usosMin ? Number(usosMin) : undefined,
      diasSemUsoRealMin: diasSemUsoRealMin ? Number(diasSemUsoRealMin) : undefined,
      semUsoDiasMin: semUsoDiasMin ? Number(semUsoDiasMin) : undefined,
      usadoNosUltimosDias: usadoNosUltimosDias ? Number(usadoNosUltimosDias) : undefined,
      tags: tags.trim() ? tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
      categoriasCompra: categoriasCompra.length ? categoriasCompra : undefined,
      compraNosUltimosDias: compraNosUltimosDias ? Number(compraNosUltimosDias) : undefined,
    }),
    [cidade, faixaUso, statusConta, perfilRenda, etapaUso, usosMin, diasSemUsoRealMin, semUsoDiasMin, usadoNosUltimosDias, tags, categoriasCompra, compraNosUltimosDias]
  );
  const ativos = (...v: unknown[]) => v.filter((x) => x !== undefined).length;
  const nCliente = ativos(filters.cidade, filters.perfilRenda, filters.statusConta, filters.tags);
  const nUso = ativos(filters.faixaUso, filters.semUsoDiasMin, filters.usadoNosUltimosDias);
  const nExtrato = ativos(filters.etapaUso, filters.usosMin, filters.diasSemUsoRealMin);
  const nCompras = ativos(filters.categoriasCompra, filters.compraNosUltimosDias);
  const total = nCliente + nUso + nExtrato + nCompras;

  function mudou() {
    setPreview(null);
    setMsg(null);
  }
  const wrap = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    mudou();
  };

  function limpar() {
    setCidade(""); setPerfilRenda([]); setStatusConta([]); setTags(""); setFaixaUso([]);
    setSemUsoDiasMin(""); setUsadoNosUltimosDias(""); setEtapaUso([]); setUsosMin("");
    setDiasSemUsoRealMin(""); setCategoriasCompra([]); setCompraNosUltimosDias("");
    mudou();
  }

  function applyPreset(preset: "recorrentes" | "semUso") {
    limpar();
    if (preset === "recorrentes") {
      setFaixaUso(["USO_31_50", "USO_51_70", "USO_71_99"]);
      setUsadoNosUltimosDias("30");
      setName("Recorrentes");
    } else {
      setSemUsoDiasMin("60");
      setName("Sem uso há 60 dias");
    }
  }

  async function criarProntos(path: string, rotulo: string) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ criados?: number }>(path, { method: "POST" });
      setMsg({ tipo: "ok", texto: `${rotulo}: pronto${typeof r?.criados === "number" ? ` (${r.criados} novo${r.criados === 1 ? "" : "s"})` : ""}. Veja na lista abaixo.` });
      load();
    } catch (e: any) {
      setMsg({ tipo: "erro", texto: e.message ?? "Não foi possível criar." });
    } finally {
      setBusy(false);
    }
  }

  async function handlePreview() {
    setBusy(true);
    try {
      const resp = await api<{ count: number }>("/segments/preview", { method: "POST", body: filters });
      setPreview(resp.count);
    } catch (e: any) {
      setMsg({ tipo: "erro", texto: e.message ?? "Não foi possível contar." });
    } finally {
      setBusy(false);
    }
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setMsg({ tipo: "erro", texto: "Dê um nome ao segmento." });
    if (total === 0) return setMsg({ tipo: "erro", texto: "Escolha pelo menos um filtro (senão o segmento seria a base inteira)." });
    setBusy(true);
    try {
      await api("/segments", { method: "POST", body: { name: name.trim(), filters, dynamic } });
      setName("");
      setPreview(null);
      setMsg({ tipo: "ok", texto: "Segmento salvo. Ele já pode ser usado em campanhas e automações." });
      load();
    } catch (e: any) {
      setMsg({ tipo: "erro", texto: e.message ?? "Não foi possível salvar." });
    } finally {
      setBusy(false);
    }
  }

  async function refresh(id: string) {
    await api(`/segments/${id}/refresh`, { method: "POST" });
    load();
  }

  return (
    <div>
      <h2>Segmentos</h2>

      <div className="card seg-intro" style={{ marginBottom: 16 }}>
        <h3>O que é um segmento?</h3>
        <p>
          Um segmento é uma <strong>lista de clientes definida por regras</strong> (por exemplo: "PF1 que já usaram o cartão mas estão
          há mais de 30 dias sem usar"). Você monta a regra uma vez e reaproveita em outros lugares.
        </p>
        <ul>
          <li><strong>Campanhas:</strong> escolha o segmento como público do disparo de WhatsApp/SMS. Clientes com opt-out e sem limite ficam de fora automaticamente.</li>
          <li><strong>Dinâmico ou estático:</strong> o dinâmico se reconta sozinho a cada hora conforme a base muda; o estático guarda só a contagem do dia em que foi criado.</li>
          <li><strong>Como as regras se combinam:</strong> filtros de grupos diferentes valem juntos (E). Dentro de um mesmo filtro, marcar várias opções vale qualquer uma delas (OU) — ex.: PF1 e PF2 = clientes de PF1 ou de PF2.</li>
        </ul>
      </div>

      <h3 style={{ margin: "0 0 4px" }}>1. Comece por um segmento pronto (opcional)</h3>
      <div className="seg-grid" style={{ marginBottom: 20 }}>
        <div className="seg-preset">
          <h4>Recorrentes</h4>
          <p>Preenche o formulário com quem usa 31–99% do limite e usou nos últimos 30 dias. Você revisa e salva.</p>
          <button type="button" className="btn secondary" onClick={() => applyPreset("recorrentes")}>Usar no formulário</button>
        </div>
        <div className="seg-preset">
          <h4>Sem uso</h4>
          <p>Preenche o formulário com quem está há 60 dias ou mais sem usar. Você revisa e salva.</p>
          <button type="button" className="btn secondary" onClick={() => applyPreset("semUso")}>Usar no formulário</button>
        </div>
        <div className="seg-preset">
          <h4>Inativos</h4>
          <p>Cria a categoria de inativos, pronta para campanhas de reativação.</p>
          <button type="button" className="btn secondary" disabled={busy} onClick={() => criarProntos("/segments/presets/inativos", "Categoria Inativos")}>Criar agora</button>
        </div>
        <div className="seg-preset">
          <h4>Perfil de renda (PF1–PF4)</h4>
          <p>Cria 11 segmentos por faixa de renda estimada pelo limite, com variações como sem uso, com saldo e limite esgotado.</p>
          <button type="button" className="btn secondary" disabled={busy} onClick={() => criarProntos("/segments/presets/perfis-renda", "Segmentos de perfil de renda")}>Criar agora</button>
        </div>
        <div className="seg-preset">
          <h4>Etapa de uso</h4>
          <p>Cria 5 segmentos pelo extrato de compras: nunca usou, recorrentes, ocasionais, em risco e inativos.</p>
          <button type="button" className="btn secondary" disabled={busy} onClick={() => criarProntos("/segments/presets/etapas-uso", "Segmentos por etapa de uso")}>Criar agora</button>
        </div>
      </div>

      <form onSubmit={handleSave} style={{ marginBottom: 20 }}>
        <h3 style={{ margin: "0 0 8px" }}>2. Monte o seu segmento</h3>

        <div className="seg-section" style={{ paddingBottom: 14 }}>
          <div className="seg-row">
            <div>
              <label className="seg-label">Nome do segmento</label>
              <input style={{ width: "100%" }} placeholder="Ex: PF1 com saldo e sem uso" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <label className="seg-label">Atualização</label>
              <div className="chip-group">
                <label className="chip"><input type="radio" name="dyn" checked={dynamic} onChange={() => setDynamic(true)} /><span>Dinâmico (recontagem a cada hora)</span></label>
                <label className="chip"><input type="radio" name="dyn" checked={!dynamic} onChange={() => setDynamic(false)} /><span>Estático</span></label>
              </div>
            </div>
          </div>
        </div>

        <Section title="Quem é o cliente" count={nCliente} defaultOpen>
          <p className="seg-hint">Características do cadastro: onde mora, renda estimada pelo limite e situação da conta.</p>
          <div className="seg-field">
            <label>Perfil de renda (salário estimado = limite ÷ 0,40)</label>
            <Chips options={PERFIL_OPTIONS} value={perfilRenda} onChange={wrap(setPerfilRenda)} />
          </div>
          <div className="seg-field">
            <label>Status da conta</label>
            <Chips options={STATUS_OPTIONS} value={statusConta} onChange={wrap(setStatusConta)} />
          </div>
          <div className="seg-row">
            <div className="seg-field">
              <label>Cidade</label>
              <input style={{ width: "100%" }} placeholder="Ex: Natal" value={cidade} onChange={(e) => wrap(setCidade)(e.target.value)} />
            </div>
            <div className="seg-field">
              <label>Tags (separadas por vírgula)</label>
              <input style={{ width: "100%" }} placeholder="Ex: comercio, varejo" value={tags} onChange={(e) => wrap(setTags)(e.target.value)} />
            </div>
          </div>
          <p className="seg-hint">Tags são aplicadas na tela "Base de clientes" (selecionar clientes → aplicar tag), úteis para públicos que não existem como coluna na planilha.</p>
        </Section>

        <Section title="Uso do limite (planilha de contas)" count={nUso}>
          <p className="seg-hint">Baseado no saldo e no limite da planilha de contas. Atenção: o limite renova depois do desconto em folha, então "0% de uso" não prova que nunca usou.</p>
          <div className="seg-field">
            <label>Faixa de uso do limite</label>
            <Chips options={FAIXA_OPTIONS.map((f) => ({ value: f.value, label: f.label }))} value={faixaUso} onChange={wrap(setFaixaUso)} />
          </div>
          <div className="seg-row">
            <div className="seg-field">
              <label>Sem usar há pelo menos (dias)</label>
              <input type="number" min={0} style={{ width: "100%" }} placeholder="Ex: 60" value={semUsoDiasMin} onChange={(e) => wrap(setSemUsoDiasMin)(e.target.value)} />
            </div>
            <div className="seg-field">
              <label>Usou nos últimos (dias)</label>
              <input type="number" min={0} style={{ width: "100%" }} placeholder="Ex: 30" value={usadoNosUltimosDias} onChange={(e) => wrap(setUsadoNosUltimosDias)(e.target.value)} />
            </div>
          </div>
        </Section>

        <Section title="Uso real (extrato de compras)" count={nExtrato}>
          <p className="seg-hint">Baseado nas transações de antecipação e compra à vista. Mais confiável, mas só vale depois de importar a planilha "Todas as Compras" (Importações) e mantê-la atualizada.</p>
          <div className="seg-field">
            <label>Etapa de uso</label>
            <Chips options={ETAPA_OPTIONS} value={etapaUso} onChange={wrap(setEtapaUso)} />
          </div>
          <div className="seg-row">
            <div className="seg-field">
              <label>Mínimo de usos nos últimos 90 dias</label>
              <input type="number" min={0} style={{ width: "100%" }} placeholder="Ex: 2" value={usosMin} onChange={(e) => wrap(setUsosMin)(e.target.value)} />
            </div>
            <div className="seg-field">
              <label>Sem uso real há pelo menos (dias)</label>
              <input type="number" min={0} style={{ width: "100%" }} placeholder="Ex: 30" value={diasSemUsoRealMin} onChange={(e) => wrap(setDiasSemUsoRealMin)(e.target.value)} />
            </div>
          </div>
        </Section>

        <Section title="Compras no comércio credenciado" count={nCompras}>
          <p className="seg-hint">Vem da aba "Todas as Compras". Sem categoria marcada, o prazo vale para qualquer compra no comércio credenciado.</p>
          <div className="seg-field">
            <label>Categoria da compra</label>
            <Chips options={categoriasDisponiveis.map((c) => ({ value: c.key, label: c.label }))} value={categoriasCompra} onChange={wrap(setCategoriasCompra)} />
          </div>
          <div className="seg-field" style={{ maxWidth: 320 }}>
            <label>Comprou nos últimos (dias)</label>
            <input type="number" min={0} style={{ width: "100%" }} placeholder="Vazio = qualquer data" value={compraNosUltimosDias} onChange={(e) => wrap(setCompraNosUltimosDias)(e.target.value)} />
          </div>
        </Section>

        <div className="seg-bar">
          <div className="seg-summary">
            {total === 0 ? "Nenhum filtro escolhido." : <><strong>{total}</strong> filtro{total > 1 ? "s" : ""} ativo{total > 1 ? "s" : ""}.</>}{" "}
            {preview !== null && <><strong>{preview.toLocaleString("pt-BR")}</strong> clientes correspondem.</>}
            {msg && <div className="seg-msg" style={{ color: msg.tipo === "ok" ? "var(--success)" : "var(--danger)" }}>{msg.texto}</div>}
          </div>
          {total > 0 && <button type="button" className="btn secondary" onClick={limpar}>Limpar filtros</button>}
          <button type="button" className="btn secondary" disabled={busy} onClick={handlePreview}>Contar público</button>
          <button className="btn" type="submit" disabled={busy}>Salvar segmento</button>
        </div>
        <p className="seg-hint" style={{ marginTop: 8 }}>
          Para combinações avançadas com E/OU entre grupos (ex.: "(cidade A e uso alto) ou (cidade B e sem uso há 90 dias)"), use a API <code>POST /api/segments</code> com <code>filters: {"{ operator, conditions, groups }"}</code>.
        </p>
      </form>

      <h3 style={{ margin: "0 0 8px" }}>3. Seus segmentos</h3>
      <div className="card">
        <table>
          <thead>
            <tr><th>Nome</th><th>Último público</th><th>Tipo</th><th>Última atualização</th><th></th></tr>
          </thead>
          <tbody>
            {segments.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td>{s.lastCount?.toLocaleString("pt-BR") ?? "—"}</td>
                <td>{s.dynamic ? "Dinâmico" : "Estático"}</td>
                <td>{s.lastRefreshedAt ? new Date(s.lastRefreshedAt).toLocaleString("pt-BR") : "—"}</td>
                <td><button className="btn secondary" onClick={() => refresh(s.id)}>Atualizar agora</button></td>
              </tr>
            ))}
            {segments.length === 0 && (
              <tr><td colSpan={5} style={{ color: "var(--text-muted)" }}>Nenhum segmento salvo ainda</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

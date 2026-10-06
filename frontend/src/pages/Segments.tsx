import { FormEvent, useEffect, useState } from "react";
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


export default function Segments() {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [name, setName] = useState("");
  const [cidade, setCidade] = useState("");
  const [faixaUso, setFaixaUso] = useState<string[]>([]);
  const [statusConta, setStatusConta] = useState<string[]>([]);
  const [semUsoDiasMin, setSemUsoDiasMin] = useState("");
  const [usadoNosUltimosDias, setUsadoNosUltimosDias] = useState("");
  const [tags, setTags] = useState("");
  const [categoriasCompra, setCategoriasCompra] = useState<string[]>([]);
  const [compraNosUltimosDias, setCompraNosUltimosDias] = useState("");
  const [categoriasDisponiveis, setCategoriasDisponiveis] = useState<{ key: string; label: string }[]>([]);
  const [dynamic, setDynamic] = useState(true);
  const [preview, setPreview] = useState<number | null>(null);

  function load() {
    api<Segment[]>("/segments").then(setSegments);
  }

  useEffect(load, []);
  useEffect(() => {
    api<{ todasCategorias: { key: string; label: string }[] }>("/purchases/categories").then((r) => setCategoriasDisponiveis(r.todasCategorias)).catch(() => {});
  }, []);

  function toggle(list: string[], value: string, setList: (v: string[]) => void) {
    setList(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }

  function currentFilters() {
    return {
      cidade: cidade ? [cidade] : undefined,
      faixaUso: faixaUso.length ? faixaUso : undefined,
      statusConta: statusConta.length ? statusConta : undefined,
      semUsoDiasMin: semUsoDiasMin ? Number(semUsoDiasMin) : undefined,
      usadoNosUltimosDias: usadoNosUltimosDias ? Number(usadoNosUltimosDias) : undefined,
      tags: tags.trim() ? tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
      categoriasCompra: categoriasCompra.length ? categoriasCompra : undefined,
      compraNosUltimosDias: compraNosUltimosDias ? Number(compraNosUltimosDias) : undefined,
    };
  }

  async function createInativos() {
    await api("/segments/presets/inativos", { method: "POST" });
    load();
  }

  function applyPreset(preset: "recorrentes" | "semUso") {
    setFaixaUso(preset === "recorrentes" ? ["USO_31_50", "USO_51_70", "USO_71_99"] : []);
    setStatusConta([]);
    setSemUsoDiasMin(preset === "semUso" ? "60" : "");
    setUsadoNosUltimosDias(preset === "recorrentes" ? "30" : "");
    setPreview(null);
  }

  async function handlePreview() {
    const resp = await api<{ count: number }>("/segments/preview", { method: "POST", body: currentFilters() });
    setPreview(resp.count);
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    await api("/segments", { method: "POST", body: { name, filters: currentFilters(), dynamic } });
    setName("");
    setPreview(null);
    load();
  }

  async function refresh(id: string) {
    await api(`/segments/${id}/refresh`, { method: "POST" });
    load();
  }

  return (
    <div>
      <h2>Segmentos</h2>
      <form className="card" style={{ marginBottom: 16 }} onSubmit={handleSave}>
        <h3>Novo segmento</h3>

        <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 10 }}>
          Atalhos para públicos comuns (ajustam os filtros abaixo — revise antes de salvar):
        </p>
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          <button type="button" className="btn secondary" onClick={() => applyPreset("recorrentes")}>
            Recorrentes
          </button>
          <button type="button" className="btn secondary" onClick={() => applyPreset("semUso")}>
            Sem uso
          </button>
          <button type="button" className="btn secondary" onClick={createInativos}>
            Criar categoria Inativos
          </button>
        </div>

        <div className="form-row">
          <label>Nome do segmento</label>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </div>

        <div className="form-row">
          <label>Cidade</label>
          <input placeholder="Ex: São Paulo" value={cidade} onChange={(e) => setCidade(e.target.value)} />
        </div>

        <div className="form-row">
          <label>Faixa de uso do limite</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px" }}>
            {FAIXA_OPTIONS.map((opt) => (
              <label key={opt.value} style={{ fontSize: 13, fontWeight: 400 }}>
                <input
                  type="checkbox"
                  checked={faixaUso.includes(opt.value)}
                  onChange={() => toggle(faixaUso, opt.value, setFaixaUso)}
                />{" "}
                {opt.label}
              </label>
            ))}
          </div>
        </div>

        <div className="form-row">
          <label>Status da conta</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px" }}>
            {STATUS_OPTIONS.map((opt) => (
              <label key={opt.value} style={{ fontSize: 13, fontWeight: 400 }}>
                <input
                  type="checkbox"
                  checked={statusConta.includes(opt.value)}
                  onChange={() => toggle(statusConta, opt.value, setStatusConta)}
                />{" "}
                {opt.label}
              </label>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <div className="form-row" style={{ flex: 1 }}>
            <label>Sem usar há pelo menos (dias)</label>
            <input
              type="number"
              min={0}
              placeholder="Ex: 60"
              value={semUsoDiasMin}
              onChange={(e) => setSemUsoDiasMin(e.target.value)}
            />
          </div>
          <div className="form-row" style={{ flex: 1 }}>
            <label>Usou nos últimos (dias) — recorrente</label>
            <input
              type="number"
              min={0}
              placeholder="Ex: 30"
              value={usadoNosUltimosDias}
              onChange={(e) => setUsadoNosUltimosDias(e.target.value)}
            />
          </div>
        </div>

        <div className="form-row">
          <label>Comprou no comércio credenciado (categoria)</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px" }}>
            {categoriasDisponiveis.map((c) => (
              <label key={c.key} style={{ fontSize: 13, fontWeight: 400 }}>
                <input
                  type="checkbox"
                  checked={categoriasCompra.includes(c.key)}
                  onChange={() => toggle(categoriasCompra, c.key, setCategoriasCompra)}
                />{" "}
                {c.label}
              </label>
            ))}
          </div>
          <input
            type="number"
            min={0}
            placeholder="Comprou nos últimos (dias) — vazio = qualquer data"
            style={{ marginTop: 8 }}
            value={compraNosUltimosDias}
            onChange={(e) => setCompraNosUltimosDias(e.target.value)}
          />
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            Vem da aba “Todas as Compras” (Importações → formato Compras). Sem categoria marcada, o prazo vale
            para qualquer compra no comércio credenciado.
          </span>
        </div>

        <div className="form-row">
          <label>Tags (separadas por vírgula)</label>
          <input placeholder="Ex: comercio, varejo" value={tags} onChange={(e) => setTags(e.target.value)} />
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            Tags são atribuídas em massa na tela "Base de clientes" (selecionar clientes → aplicar tag) —
            útil para públicos que não existem como coluna na planilha, como canal de uso predominante.
          </span>
        </div>

        <label style={{ fontSize: 13 }}>
          <input type="checkbox" checked={dynamic} onChange={(e) => setDynamic(e.target.checked)} /> Segmento dinâmico
          (recontagem automática a cada hora)
        </label>
        <div style={{ marginTop: 10 }}>
          <button type="button" className="btn secondary" onClick={handlePreview}>
            Contar público
          </button>{" "}
          {preview !== null && <span>{preview} clientes correspondem aos filtros</span>}
        </div>
        <div style={{ marginTop: 10 }}>
          <button className="btn" type="submit">Salvar segmento</button>
        </div>
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
          Para combinar grupos de filtros com AND/OR (ex: "(cidade=SP E uso alto) OU (cidade=RJ E sem uso há 90 dias)"),
          use a API <code>POST /api/segments</code> com <code>filters: {"{ operator, conditions, groups }"}</code>.
        </p>
      </form>

      <div className="card">
        <table>
          <thead>
            <tr><th>Nome</th><th>Último público</th><th>Tipo</th><th>Última atualização</th><th></th></tr>
          </thead>
          <tbody>
            {segments.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td>{s.lastCount ?? "—"}</td>
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

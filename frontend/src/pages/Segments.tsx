import { FormEvent, useEffect, useState } from "react";
import { api } from "../api/client";

interface Segment {
  id: string;
  name: string;
  lastCount: number | null;
  dynamic: boolean;
  lastRefreshedAt: string | null;
  createdAt: string;
}

export default function Segments() {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [name, setName] = useState("");
  const [cidade, setCidade] = useState("");
  const [faixaUso, setFaixaUso] = useState("");
  const [dynamic, setDynamic] = useState(true);
  const [preview, setPreview] = useState<number | null>(null);

  function load() {
    api<Segment[]>("/segments").then(setSegments);
  }

  useEffect(load, []);

  function currentFilters() {
    return {
      cidade: cidade ? [cidade] : undefined,
      faixaUso: faixaUso ? [faixaUso] : undefined,
    };
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
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <input placeholder="Nome do segmento" value={name} onChange={(e) => setName(e.target.value)} required />
          <input placeholder="Cidade" value={cidade} onChange={(e) => setCidade(e.target.value)} />
          <select value={faixaUso} onChange={(e) => setFaixaUso(e.target.value)}>
            <option value="">Qualquer faixa</option>
            <option value="NAO_UTILIZOU">Não utilizou</option>
            <option value="BAIXO_USO">Baixo uso</option>
            <option value="USO_INICIAL">Uso inicial</option>
            <option value="USO_INTERMEDIARIO">Uso intermediário</option>
            <option value="USO_ALTO">Uso alto</option>
            <option value="QUASE_COMPLETO">Quase completo</option>
            <option value="LIMITE_COMPLETO">Limite completo</option>
          </select>
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
          Para combinar grupos de filtros com AND/OR (segment builder avançado), use a API{" "}
          <code>POST /api/segments</code> com <code>filters: {"{ operator, conditions, groups }"}</code>.
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

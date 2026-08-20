import { FormEvent, useEffect, useState } from "react";
import { api } from "../api/client";

interface Segment {
  id: string;
  name: string;
  lastCount: number | null;
  createdAt: string;
}

export default function Segments() {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [name, setName] = useState("");
  const [cidade, setCidade] = useState("");
  const [faixaUso, setFaixaUso] = useState("");
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
    await api("/segments", { method: "POST", body: { name, filters: currentFilters() } });
    setName("");
    setPreview(null);
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
        <button type="button" className="btn secondary" onClick={handlePreview}>
          Contar público
        </button>{" "}
        {preview !== null && <span>{preview} clientes correspondem aos filtros</span>}
        <div style={{ marginTop: 10 }}>
          <button className="btn" type="submit">Salvar segmento</button>
        </div>
      </form>

      <div className="card">
        <table>
          <thead>
            <tr><th>Nome</th><th>Último público</th><th>Criado em</th></tr>
          </thead>
          <tbody>
            {segments.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td>{s.lastCount ?? "—"}</td>
                <td>{new Date(s.createdAt).toLocaleDateString("pt-BR")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

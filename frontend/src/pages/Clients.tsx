import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";

interface ClientRow {
  id: string;
  nome: string;
  telefone: string;
  cidade: string | null;
  faixaUso: string;
  percentualUtilizado: string;
  statusConta: string;
  autorizacaoComunicacao: boolean;
}

export default function Clients() {
  const [items, setItems] = useState<ClientRow[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [cidade, setCidade] = useState("");
  const [faixaUso, setFaixaUso] = useState("");
  const [page, setPage] = useState(1);

  async function load() {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (cidade) params.set("cidade", cidade);
    if (faixaUso) params.set("faixaUso", faixaUso);
    params.set("page", String(page));

    const resp = await api<{ items: ClientRow[]; total: number }>(`/clients?${params.toString()}`);
    setItems(resp.items);
    setTotal(resp.total);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  return (
    <div>
      <h2>Base de clientes</h2>
      <div className="card" style={{ marginBottom: 16, display: "flex", gap: 8 }}>
        <input placeholder="Buscar por nome/telefone" value={search} onChange={(e) => setSearch(e.target.value)} />
        <input placeholder="Cidade" value={cidade} onChange={(e) => setCidade(e.target.value)} />
        <select value={faixaUso} onChange={(e) => setFaixaUso(e.target.value)}>
          <option value="">Todas as faixas</option>
          <option value="NAO_UTILIZOU">Não utilizou</option>
          <option value="BAIXO_USO">Baixo uso</option>
          <option value="USO_INICIAL">Uso inicial</option>
          <option value="USO_INTERMEDIARIO">Uso intermediário</option>
          <option value="USO_ALTO">Uso alto</option>
          <option value="QUASE_COMPLETO">Quase completo</option>
          <option value="LIMITE_COMPLETO">Limite completo</option>
        </select>
        <button className="btn" onClick={() => { setPage(1); load(); }}>
          Filtrar
        </button>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Nome</th>
              <th>Telefone</th>
              <th>Cidade</th>
              <th>% Uso</th>
              <th>Faixa</th>
              <th>Status</th>
              <th>Autorização</th>
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link to={`/clients/${c.id}`}>{c.nome}</Link>
                </td>
                <td>{c.telefone}</td>
                <td>{c.cidade || "—"}</td>
                <td>{Number(c.percentualUtilizado).toFixed(1)}%</td>
                <td>{c.faixaUso}</td>
                <td>
                  <span className={`badge ${c.statusConta === "ATIVO" ? "ok" : c.statusConta === "BLOQUEADO" ? "danger" : "warn"}`}>
                    {c.statusConta}
                  </span>
                </td>
                <td>{c.autorizacaoComunicacao ? "Sim" : "Não"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ marginTop: 12, display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: "var(--text-muted)", fontSize: 13 }}>{total} clientes encontrados</span>
          <div>
            <button className="btn secondary" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
              Anterior
            </button>{" "}
            <button className="btn secondary" onClick={() => setPage((p) => p + 1)}>
              Próxima
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

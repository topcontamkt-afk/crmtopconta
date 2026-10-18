import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, downloadFile } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { FAIXA_OPTIONS } from "../utils/faixas";

interface ClientRow {
  id: string;
  nome: string;
  telefone: string; // mascarado pelo servidor para quem não pode ver o número completo (LGPD 01-04)
  cidade: string | null;
  faixaUso: string;
  percentualUtilizado: string;
  statusConta: string;
  autorizacaoComunicacao: boolean;
  bloqueadoLgpdAt: string | null;
}

type Bloqueados = "excluir" | "incluir" | "somente";

export default function Clients() {
  const { user } = useAuth();
  // Filtros iniciais podem vir por link (ex.: cards de "Oportunidades" no Dashboard, que
  // apontam pra cá com ?faixaUso=... ou ?statusConta=... já preenchidos). A busca por nome/telefone
  // nunca vem pela URL (LGPD 07-03).
  const [searchParams] = useSearchParams();
  const [items, setItems] = useState<ClientRow[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [cidade, setCidade] = useState(searchParams.get("cidade") || "");
  const [empresaConveniada, setEmpresaConveniada] = useState(searchParams.get("empresaConveniada") || "");
  const [faixaUso, setFaixaUso] = useState(searchParams.get("faixaUso") || "");
  const [statusConta, setStatusConta] = useState(searchParams.get("statusConta") || "");
  const [bloqueados, setBloqueados] = useState<Bloqueados>("excluir");
  const [page, setPage] = useState(1);
  const [erro, setErro] = useState<string | null>(null);

  function filtros() {
    return {
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(cidade ? { cidade } : {}),
      ...(empresaConveniada ? { empresaConveniada } : {}),
      ...(faixaUso ? { faixaUso } : {}),
      ...(statusConta ? { statusConta } : {}),
    };
  }

  async function load() {
    // LGPD 07-03: termo de busca e filtros vão no corpo do POST, não na URL
    const resp = await api<{ items: ClientRow[]; total: number }>("/clients/search", {
      method: "POST",
      body: { ...filtros(), bloqueados, page },
    });
    setItems(resp.items);
    setTotal(resp.total);
  }

  async function exportar(completo: boolean) {
    setErro(null);
    let extra = {};
    if (completo) {
      // LGPD 05-01: telefone completo só para ADMIN, com motivo registrado na Auditoria
      const motivo = window.prompt("Motivo para exportar o telefone completo (fica registrado na Auditoria):")?.trim();
      if (!motivo) return;
      extra = { completo: true, motivo };
    }
    try {
      await downloadFile("/clients/export.csv", "clientes.csv", { method: "POST", body: { ...filtros(), ...extra } });
    } catch (e) {
      setErro((e as Error).message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2>Base de clientes</h2>
        {(user?.role === "ADMIN" || user?.role === "OPERATOR") && (
          <Link to="/clients/pedidos-titular" className="btn secondary">
            Pedidos de titular (LGPD)
          </Link>
        )}
      </div>
      <div className="card" style={{ marginBottom: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input placeholder="Buscar por nome/telefone" value={search} onChange={(e) => setSearch(e.target.value)} />
        <input placeholder="Cidade" value={cidade} onChange={(e) => setCidade(e.target.value)} />
        <input placeholder="Secretaria/convênio" value={empresaConveniada} onChange={(e) => setEmpresaConveniada(e.target.value)} />
        <select value={faixaUso} onChange={(e) => setFaixaUso(e.target.value)}>
          <option value="">Todas as faixas</option>
          {FAIXA_OPTIONS.map((f) => (
            <option key={f.value} value={f.value}>{f.label}</option>
          ))}
        </select>
        <select value={statusConta} onChange={(e) => setStatusConta(e.target.value)}>
          <option value="">Todos os status</option>
          <option value="ATIVO">Ativo</option>
          <option value="INATIVO">Inativo</option>
          <option value="BLOQUEADO">Bloqueado</option>
        </select>
        <select value={bloqueados} onChange={(e) => setBloqueados(e.target.value as Bloqueados)} title="Tratamento suspenso a pedido do titular (LGPD)">
          <option value="excluir">Sem tratamento suspenso</option>
          <option value="incluir">Incluir tratamento suspenso</option>
          <option value="somente">Só tratamento suspenso</option>
        </select>
        <button className="btn" onClick={() => { setPage(1); load(); }}>
          Filtrar
        </button>
        <button className="btn secondary" onClick={() => exportar(false)} title="Telefone sai mascarado; clientes com tratamento suspenso não entram">
          Exportar CSV
        </button>
        {user?.role === "ADMIN" && (
          <button className="btn secondary" onClick={() => exportar(true)}>
            Exportar com telefone completo
          </button>
        )}
      </div>
      {erro && <div className="card" style={{ marginBottom: 16, color: "var(--danger)" }}>{erro}</div>}

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
                  {c.bloqueadoLgpdAt && (
                    <> <span className="badge danger" title="Tratamento suspenso a pedido do titular">Suspenso (LGPD)</span></>
                  )}
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

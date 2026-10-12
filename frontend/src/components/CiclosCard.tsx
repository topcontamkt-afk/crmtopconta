import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { fmtInt } from "../utils/perfisRenda";

interface Item {
  cidadeKey: string;
  cidade: string;
  diaAbertura: number;
  abriuHa: number;
  abreEm: number;
  proximaAbertura: string;
  clientes: number;
}
interface Resp {
  hoje: string;
  configurado: boolean;
  cidades: Item[];
}

/** Cidades com limite recém-renovado (abriu há até 2 dias) ou que abrem nos próximos 7 dias. */
export default function CiclosCard() {
  const [data, setData] = useState<Resp | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [criando, setCriando] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api<Resp>("/ciclos/proximos?dias=7").then(setData).catch(() => setData(null));
  }, []);

  if (!data) return null;

  async function criar(item: Item) {
    setCriando(item.cidadeKey);
    setErro(null);
    try {
      const r = await api<{ total: number; clientIds: string[]; mensagem: string }>(`/ciclos/audiencia?cidadeKey=${encodeURIComponent(item.cidadeKey)}`);
      if (r.total === 0) return setErro("Nenhum cliente apto a receber nesta cidade.");
      navigate("/campaigns/new", {
        state: { presetClientIds: r.clientIds, presetLabel: `Ciclo ${item.cidade}`, presetMessage: r.mensagem },
      });
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setCriando(null);
    }
  }

  return (
    <div className="card pd-card pd-grow-1">
      <h3>Ciclos das cidades</h3>
      {!data.configurado ? (
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
          Cadastre o dia de abertura do ciclo de cada cidade (quando o limite renova) para ver aqui quem acabou de renovar. <Link to="/ciclos">Cadastrar ciclos</Link>
        </p>
      ) : data.cidades.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Nenhuma cidade abre ciclo nos próximos 7 dias. <Link to="/ciclos">Ver ciclos</Link></p>
      ) : (
        <table>
          <thead><tr><th>Cidade</th><th>Situação</th><th>Podem receber</th><th></th></tr></thead>
          <tbody>
            {data.cidades.map((c) => (
              <tr key={c.cidadeKey}>
                <td>{c.cidade}</td>
                <td>
                  {c.abriuHa === 0 ? <span className="badge ok">Abriu hoje</span> : c.abriuHa <= 2 ? <span className="badge ok">Abriu há {c.abriuHa} dia{c.abriuHa === 1 ? "" : "s"}</span> : <>Abre {c.proximaAbertura} (em {c.abreEm} dia{c.abreEm === 1 ? "" : "s"})</>}
                </td>
                <td>{fmtInt(c.clientes)}</td>
                <td>
                  {c.abriuHa <= 2 && c.clientes > 0 && (
                    <button className="btn secondary" disabled={criando !== null} onClick={() => criar(c)}>{criando === c.cidadeKey ? "..." : "Criar campanha"}</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {erro && <p className="error-text">{erro}</p>}
    </div>
  );
}

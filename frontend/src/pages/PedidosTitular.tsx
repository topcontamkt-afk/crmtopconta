import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api, downloadFile } from "../api/client";
import { useAuth } from "../context/AuthContext";

/**
 * LGPD 03-05: registro dos pedidos de titular (art. 18) com o prazo de 15 dias do art. 19, II. ADMIN e
 * OPERATOR registram e consultam; só ADMIN fecha o pedido com a resposta dada.
 */
interface Pedido {
  id: string;
  clientId: string | null;
  clienteNome: string | null;
  telefoneMasked: string | null;
  tipo: string;
  canal: string;
  status: "ABERTO" | "ATENDIDO" | "NEGADO";
  descricao: string | null;
  recebidoEm: string;
  prazoEm: string;
  respondidoEm: string | null;
  resposta: string | null;
  vencido: boolean;
  diasRestantes: number | null;
}

const TIPOS: Record<string, string> = {
  CONFIRMACAO: "Confirmação de tratamento",
  ACESSO: "Acesso aos dados",
  CORRECAO: "Correção",
  ELIMINACAO: "Eliminação",
  BLOQUEIO: "Bloqueio / suspensão",
  PORTABILIDADE: "Portabilidade",
  COMPARTILHAMENTO: "Com quem foi compartilhado",
  OPOSICAO: "Oposição",
  REVOGACAO: "Revogação / descadastro",
};
const CANAIS: Record<string, string> = { WHATSAPP: "WhatsApp", SMS: "SMS", EMAIL: "E-mail", TELEFONE: "Telefone", OUTRO: "Outro" };
const fmt = (iso: string) => new Date(iso).toLocaleDateString("pt-BR");

export default function PedidosTitular() {
  const { user } = useAuth();
  const admin = user?.role === "ADMIN";
  const location = useLocation();
  const origem = (location.state as { clientId?: string; nome?: string } | null) ?? null;

  const [itens, setItens] = useState<Pedido[]>([]);
  const [vencidos, setVencidos] = useState(0);
  const [filtro, setFiltro] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [novo, setNovo] = useState({ tipo: "ACESSO", canal: "WHATSAPP", telefone: "", descricao: "", recebidoEm: "" });
  const [criando, setCriando] = useState(!!origem?.clientId);
  const [fechando, setFechando] = useState<{ id: string; status: "ATENDIDO" | "NEGADO"; resposta: string; telefone: string; pedeTelefone: boolean } | null>(null);

  const carregar = useCallback(() => {
    const qs = filtro ? `?status=${filtro}` : "";
    api<{ itens: Pedido[]; vencidos: number }>(`/titular/pedidos${qs}`)
      .then((r) => {
        setItens(r.itens);
        setVencidos(r.vencidos);
      })
      .catch((e) => setErro(e.message));
  }, [filtro]);
  useEffect(() => carregar(), [carregar]);

  async function criar() {
    setErro(null);
    try {
      await api("/titular/pedidos", {
        method: "POST",
        body: {
          tipo: novo.tipo,
          canal: novo.canal,
          ...(origem?.clientId ? { clientId: origem.clientId } : novo.telefone.trim() ? { telefone: novo.telefone.trim() } : {}),
          ...(novo.descricao.trim() ? { descricao: novo.descricao.trim() } : {}),
          ...(novo.recebidoEm ? { recebidoEm: new Date(`${novo.recebidoEm}T12:00:00`).toISOString() } : {}),
        },
      });
      setCriando(false);
      setNovo({ tipo: "ACESSO", canal: "WHATSAPP", telefone: "", descricao: "", recebidoEm: "" });
      carregar();
    } catch (e) {
      setErro((e as Error).message);
    }
  }

  // LGPD 03-09: quem não é cliente da base é achado pelo telefone, digitado na hora (não fica guardado no pedido)
  async function relatorioDoContato(p: Pedido) {
    const telefone = window.prompt("Telefone do titular (com DDD):");
    if (!telefone) return;
    setErro(null);
    try {
      await downloadFile(`/titular/pedidos/${p.id}/relatorio-contato`, `contato-${p.id.slice(0, 8)}.json`, { method: "POST", body: { telefone } });
    } catch (e) {
      setErro((e as Error).message);
    }
  }

  async function eliminarContato(p: Pedido) {
    const telefone = window.prompt("Telefone do titular (com DDD):");
    if (!telefone) return;
    const confirmacao = window.prompt(
      "Isto apaga do CRM as conversas, as listas e os dados de envio deste número (não dá para desfazer). Para confirmar, digite: ELIMINAR DADOS"
    );
    if (!confirmacao) return;
    setErro(null);
    try {
      const r = await api<{ copiasExternas?: { conversas: number }[] }>(`/titular/pedidos/${p.id}/eliminar-contato`, {
        method: "POST",
        body: { telefone, confirmacao },
      });
      if (r.copiasExternas?.length) {
        window.alert("Feito. Há conversas pela Z-API: apague também a cópia no aparelho conectado.");
      }
      carregar();
    } catch (e) {
      setErro((e as Error).message);
    }
  }

  async function fechar() {
    if (!fechando) return;
    setErro(null);
    try {
      const body: Record<string, string> = { status: fechando.status, resposta: fechando.resposta };
      if (fechando.pedeTelefone && fechando.telefone.trim()) body.telefone = fechando.telefone.trim();
      await api(`/titular/pedidos/${fechando.id}/fechar`, { method: "POST", body });
      setFechando(null);
      carregar();
    } catch (e) {
      setErro((e as Error).message);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2>Pedidos de titular (LGPD)</h2>
        {!criando && (
          <button className="btn" onClick={() => setCriando(true)}>
            Registrar pedido
          </button>
        )}
      </div>
      <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
        Prazo de resposta: 15 dias a partir do recebimento (art. 19, II). {vencidos > 0 && <strong style={{ color: "var(--danger)" }}>{vencidos} vencido(s).</strong>}
      </p>
      {erro && <div className="card" style={{ marginBottom: 16, color: "var(--danger)" }}>{erro}</div>}

      {criando && (
        <div className="card" style={{ marginBottom: 16, display: "grid", gap: 8, maxWidth: 520 }}>
          <h3>Novo pedido{origem?.nome ? ` · ${origem.nome}` : ""}</h3>
          <label>
            Tipo{" "}
            <select value={novo.tipo} onChange={(e) => setNovo({ ...novo, tipo: e.target.value })}>
              {Object.entries(TIPOS).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </label>
          <label>
            Canal{" "}
            <select value={novo.canal} onChange={(e) => setNovo({ ...novo, canal: e.target.value })}>
              {Object.entries(CANAIS).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </label>
          {!origem?.clientId && (
            <label>
              Telefone (se não for cliente da base; fica guardado mascarado){" "}
              <input value={novo.telefone} onChange={(e) => setNovo({ ...novo, telefone: e.target.value })} />
            </label>
          )}
          <label>
            Recebido em (vazio = hoje){" "}
            <input type="date" value={novo.recebidoEm} onChange={(e) => setNovo({ ...novo, recebidoEm: e.target.value })} />
          </label>
          <label>
            Descrição{" "}
            <textarea rows={3} value={novo.descricao} onChange={(e) => setNovo({ ...novo, descricao: e.target.value })} />
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" onClick={criar}>Registrar</button>
            <button className="btn secondary" onClick={() => setCriando(false)}>Cancelar</button>
          </div>
        </div>
      )}

      {fechando && (
        <div className="card" style={{ marginBottom: 16, display: "grid", gap: 8, maxWidth: 520 }}>
          <h3>Fechar pedido</h3>
          <label>
            Resultado{" "}
            <select value={fechando.status} onChange={(e) => setFechando({ ...fechando, status: e.target.value as "ATENDIDO" | "NEGADO" })}>
              <option value="ATENDIDO">Atendido</option>
              <option value="NEGADO">Negado</option>
            </select>
          </label>
          {fechando.pedeTelefone && fechando.status === "ATENDIDO" && (
            <label>
              Telefone de quem pediu para parar{" "}
              <input value={fechando.telefone} onChange={(e) => setFechando({ ...fechando, telefone: e.target.value })} placeholder="(84) 99999-9999" />
              <small style={{ display: "block", color: "var(--text-muted)" }}>
                Atender revogação ou oposição descadastra o número em todos os cadastros e listas. O número não fica guardado no pedido.
              </small>
            </label>
          )}
          <label>
            Resposta dada ao titular{" "}
            <textarea rows={3} value={fechando.resposta} onChange={(e) => setFechando({ ...fechando, resposta: e.target.value })} />
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" onClick={fechar} disabled={fechando.resposta.trim().length < 3}>Fechar pedido</button>
            <button className="btn secondary" onClick={() => setFechando(null)}>Cancelar</button>
          </div>
        </div>
      )}

      <div className="card">
        <div style={{ marginBottom: 8 }}>
          <select value={filtro} onChange={(e) => setFiltro(e.target.value)}>
            <option value="">Todos</option>
            <option value="ABERTO">Abertos</option>
            <option value="ATENDIDO">Atendidos</option>
            <option value="NEGADO">Negados</option>
          </select>
        </div>
        <table>
          <thead>
            <tr>
              <th>Titular</th>
              <th>Tipo</th>
              <th>Canal</th>
              <th>Recebido</th>
              <th>Prazo</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {itens.map((p) => (
              <tr key={p.id} style={p.vencido ? { background: "color-mix(in srgb, var(--danger) 10%, transparent)" } : undefined}>
                <td>
                  {p.clientId ? <Link to={`/clients/${p.clientId}`}>{p.clienteNome ?? "Cliente"}</Link> : p.telefoneMasked ?? "—"}
                  {p.descricao && <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{p.descricao}</div>}
                </td>
                <td>{TIPOS[p.tipo] ?? p.tipo}</td>
                <td>{CANAIS[p.canal] ?? p.canal}</td>
                <td>{fmt(p.recebidoEm)}</td>
                <td>
                  {fmt(p.prazoEm)}
                  {p.vencido && <> <span className="badge danger">Vencido</span></>}
                  {!p.vencido && p.diasRestantes !== null && <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{p.diasRestantes} dia(s)</div>}
                </td>
                <td>
                  <span className={`badge ${p.status === "ABERTO" ? "warn" : p.status === "ATENDIDO" ? "ok" : "danger"}`}>{p.status}</span>
                  {p.respondidoEm && <div style={{ color: "var(--text-muted)", fontSize: 12 }}>em {fmt(p.respondidoEm)}</div>}
                  {p.resposta && <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{p.resposta}</div>}
                </td>
                <td>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {admin && !p.clientId && (
                      <button className="btn secondary" onClick={() => relatorioDoContato(p)}>Relatório</button>
                    )}
                    {admin && !p.clientId && p.tipo === "ELIMINACAO" && p.status === "ABERTO" && (
                      <button className="btn danger" onClick={() => eliminarContato(p)}>Eliminar contato</button>
                    )}
                    {admin && p.status === "ABERTO" && (
                      <button className="btn secondary" onClick={() => setFechando({ id: p.id, status: "ATENDIDO", resposta: "", telefone: "", pedeTelefone: !p.clientId && (p.tipo === "REVOGACAO" || p.tipo === "OPOSICAO") })}>
                        Fechar
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {itens.length === 0 && (
              <tr><td colSpan={7} style={{ color: "var(--text-muted)" }}>Nenhum pedido registrado</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

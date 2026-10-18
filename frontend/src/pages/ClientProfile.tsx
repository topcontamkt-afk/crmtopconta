import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, downloadFile } from "../api/client";
import { useAuth } from "../context/AuthContext";

interface ClientDetail {
  id: string;
  nome: string;
  telefone: string; // mascarado pelo servidor para VIEWER (LGPD 01-04)
  telefoneMascarado?: boolean;
  email?: string | null;
  cpfMasked: string;
  cidade: string | null;
  limiteTotal: string;
  valorUtilizado: string;
  saldoDisponivel: string;
  percentualUtilizado: string;
  faixaUso: string;
  statusConta: string;
  autorizacaoComunicacao: boolean;
  tags: string[];
  bloqueadoLgpdAt: string | null;
  camposCorrigidos: Record<string, string> | null;
  movements: { id: string; tipo: string; valor: string; data: string }[];
  messageEvents: {
    id: string;
    channel: string;
    status: string;
    queuedAt: string;
    campaign: { name: string };
  }[];
}

const fmtData = (iso: string) => new Date(iso).toLocaleDateString("pt-BR");

export default function ClientProfile() {
  const { id } = useParams();
  const { user } = useAuth();
  const admin = user?.role === "ADMIN";
  const podeEditar = admin || user?.role === "OPERATOR";
  const [client, setClient] = useState<ClientDetail | null>(null);
  const [editando, setEditando] = useState(false);
  const [form, setForm] = useState({ nome: "", cidade: "", telefone: "", email: "" });
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const carregar = useCallback(() => {
    if (id) api<ClientDetail>(`/clients/${id}`).then(setClient).catch((e) => setErro(e.message));
  }, [id]);
  useEffect(() => carregar(), [carregar]);

  if (!client) return <div>{erro ?? "Carregando..."}</div>;

  function abrirEdicao() {
    if (!client) return;
    setForm({ nome: client.nome, cidade: client.cidade ?? "", telefone: client.telefone, email: client.email ?? "" });
    setEditando(true);
  }

  // LGPD 03-03: correção a pedido do titular; o servidor normaliza e trava o campo contra a reimportação
  async function salvar() {
    if (!client) return;
    setErro(null);
    const body: Record<string, string | null> = {};
    if (form.nome.trim() !== client.nome) body.nome = form.nome.trim();
    if (form.cidade.trim() !== (client.cidade ?? "")) body.cidade = form.cidade.trim();
    if (form.telefone.trim() !== client.telefone) body.telefone = form.telefone.trim();
    if (form.email.trim() !== (client.email ?? "")) body.email = form.email.trim() || null;
    if (!Object.keys(body).length) return setEditando(false);
    try {
      await api(`/clients/${client.id}`, { method: "PATCH", body });
      setEditando(false);
      setAviso("Dados corrigidos. Os campos alterados não serão sobrescritos pela próxima importação; avise o responsável pela planilha.");
      carregar();
    } catch (e) {
      setErro((e as Error).message);
    }
  }

  // LGPD 03-04: suspensão do tratamento (bloqueio do art. 18, IV)
  async function alternarBloqueio() {
    if (!client) return;
    const bloquear = !client.bloqueadoLgpdAt;
    const texto = bloquear
      ? "Suspender o tratamento dos dados deste cliente? Ele sai da listagem padrão, do export, de segmentos e de campanhas até ser liberado."
      : "Retomar o tratamento dos dados deste cliente?";
    if (!window.confirm(texto)) return;
    setErro(null);
    try {
      await api(`/clients/${client.id}/bloqueio`, { method: bloquear ? "POST" : "DELETE" });
      carregar();
    } catch (e) {
      setErro((e as Error).message);
    }
  }

  // LGPD 03-02: relatório completo do titular (acesso e portabilidade), em JSON
  async function baixarRelatorio() {
    if (!client) return;
    setErro(null);
    try {
      await downloadFile(`/clients/${client.id}/relatorio-titular`, `titular-${client.id.slice(0, 8)}.json`);
    } catch (e) {
      setErro((e as Error).message);
    }
  }

  const corrigido = (campo: string) =>
    client.camposCorrigidos?.[campo] ? (
      <span style={{ color: "var(--text-muted)", fontSize: 12 }}> (corrigido em {fmtData(client.camposCorrigidos[campo])})</span>
    ) : null;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h2>
          {client.nome}{" "}
          {client.bloqueadoLgpdAt && (
            <span className="badge danger" title="Tratamento suspenso a pedido do titular">
              Tratamento suspenso (LGPD) desde {fmtData(client.bloqueadoLgpdAt)}
            </span>
          )}
        </h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {podeEditar && (
            <Link className="btn secondary" to="/clients/pedidos-titular" state={{ clientId: client.id, nome: client.nome }}>
              Registrar pedido do titular
            </Link>
          )}
          {podeEditar && !editando && (
            <button className="btn secondary" onClick={abrirEdicao}>
              Corrigir dados
            </button>
          )}
          {admin && (
            <button className="btn secondary" onClick={baixarRelatorio}>
              Baixar relatório do titular
            </button>
          )}
          {admin && (
            <button className="btn secondary" onClick={alternarBloqueio}>
              {client.bloqueadoLgpdAt ? "Retomar tratamento" : "Suspender tratamento"}
            </button>
          )}
        </div>
      </div>
      {erro && <div className="card" style={{ marginBottom: 16, color: "var(--danger)" }}>{erro}</div>}
      {aviso && <div className="card" style={{ marginBottom: 16 }}>{aviso}</div>}

      {editando && (
        <div className="card" style={{ marginBottom: 16, display: "grid", gap: 8, maxWidth: 480 }}>
          <h3>Corrigir dados a pedido do titular</h3>
          <label>Nome <input value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} /></label>
          <label>Cidade <input value={form.cidade} onChange={(e) => setForm({ ...form, cidade: e.target.value })} /></label>
          <label>Telefone <input value={form.telefone} onChange={(e) => setForm({ ...form, telefone: e.target.value })} placeholder="(84) 99999-9999" /></label>
          <label>E-mail <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" onClick={salvar}>Salvar correção</button>
            <button className="btn secondary" onClick={() => setEditando(false)}>Cancelar</button>
          </div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div className="card">
          <h3>Dados cadastrais</h3>
          <p>Telefone: {client.telefone}{corrigido("telefone")}</p>
          {client.email !== undefined && <p>E-mail: {client.email || "—"}{corrigido("email")}</p>}
          <p>CPF: {client.cpfMasked}</p>
          <p>Cidade: {client.cidade || "—"}{corrigido("cidade")}</p>
          <p>Status: {client.statusConta}</p>
          <p>Autorização de comunicação: {client.autorizacaoComunicacao ? "Sim" : "Não"}</p>
          <p>Etiquetas: {client.tags.join(", ") || "—"}</p>
        </div>
        <div className="card">
          <h3>Limites e uso</h3>
          <p>Limite total: R$ {Number(client.limiteTotal).toFixed(2)}</p>
          <p>Valor utilizado: R$ {Number(client.valorUtilizado).toFixed(2)}</p>
          <p>Saldo disponível: R$ {Number(client.saldoDisponivel).toFixed(2)}</p>
          <p>
            Percentual utilizado: {Number(client.percentualUtilizado).toFixed(1)}% ({client.faixaUso})
          </p>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Histórico de movimentações</h3>
        <table>
          <thead>
            <tr><th>Data</th><th>Tipo</th><th>Valor</th></tr>
          </thead>
          <tbody>
            {client.movements.map((m) => (
              <tr key={m.id}>
                <td>{new Date(m.data).toLocaleDateString("pt-BR")}</td>
                <td>{m.tipo}</td>
                <td>R$ {Number(m.valor).toFixed(2)}</td>
              </tr>
            ))}
            {client.movements.length === 0 && (
              <tr><td colSpan={3} style={{ color: "var(--text-muted)" }}>Sem movimentações registradas</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Campanhas recebidas / mensagens</h3>
        <table>
          <thead>
            <tr><th>Campanha</th><th>Canal</th><th>Status</th><th>Enviado em</th></tr>
          </thead>
          <tbody>
            {client.messageEvents.map((e) => (
              <tr key={e.id}>
                <td>{e.campaign?.name}</td>
                <td>{e.channel}</td>
                <td>{e.status}</td>
                <td>{new Date(e.queuedAt).toLocaleString("pt-BR")}</td>
              </tr>
            ))}
            {client.messageEvents.length === 0 && (
              <tr><td colSpan={4} style={{ color: "var(--text-muted)" }}>Nenhuma campanha recebida ainda</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

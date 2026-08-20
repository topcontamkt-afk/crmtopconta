import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api/client";

interface ClientDetail {
  id: string;
  nome: string;
  telefone: string;
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
  movements: { id: string; tipo: string; valor: string; data: string }[];
  messageEvents: {
    id: string;
    channel: string;
    status: string;
    queuedAt: string;
    campaign: { name: string };
  }[];
}

export default function ClientProfile() {
  const { id } = useParams();
  const [client, setClient] = useState<ClientDetail | null>(null);

  useEffect(() => {
    if (id) api<ClientDetail>(`/clients/${id}`).then(setClient);
  }, [id]);

  if (!client) return <div>Carregando...</div>;

  return (
    <div>
      <h2>{client.nome}</h2>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div className="card">
          <h3>Dados cadastrais</h3>
          <p>Telefone: {client.telefone}</p>
          <p>CPF: {client.cpfMasked}</p>
          <p>Cidade: {client.cidade || "—"}</p>
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

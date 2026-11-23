import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { api } from "../api/client";

type Situacao = "destaque" | "estavel" | "observar" | "atencao" | "poucos_dados";

interface Cidade {
  cidadeKey: string;
  cidade: string;
  clientes: number;
  inativos: number;
  taxaUso: number | null;
  taxaUsoAnterior: number | null;
  variacaoPp: number | null;
  situacao: Situacao;
  motivo: string;
  clientesEmJogo: number;
  abreEmDias: number | null;
}

interface Resp {
  disponivel: boolean;
  motivo: "SEM_EXTRATO" | null;
  ultimoDiaExtrato: string | null;
  diasDefasagem: number | null;
  extratoEmDia?: boolean;
  cidades: Cidade[];
  emDestaque: Cidade | null;
  precisaAtencao: Cidade | null;
  mediana: number | null;
}

const intFmt = new Intl.NumberFormat("pt-BR");
const p1 = (n: number) => n.toFixed(1).replace(".", ",");
const dia = (iso: string) => iso.split("-").reverse().join("/");

const SITUACAO: Record<Situacao, { label: string; cor: string }> = {
  destaque: { label: "Destaque", cor: "var(--success)" },
  estavel: { label: "Estável", cor: "var(--text-muted)" },
  observar: { label: "Observar", cor: "var(--warning)" },
  atencao: { label: "Atenção", cor: "var(--danger)" },
  poucos_dados: { label: "Poucos dados", cor: "var(--text-muted)" },
};

function Variacao({ pp }: { pp: number | null }) {
  if (pp === null) return <span className="pd-delta flat">—</span>;
  const classe = Math.abs(pp) < 1 ? "flat" : pp > 0 ? "up" : "down";
  const Icone = Math.abs(pp) < 1 ? Minus : pp > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`pd-delta ${classe}`}>
      <Icone size={12} /> {pp > 0 ? "+" : pp < 0 ? "−" : ""}
      {p1(Math.abs(pp))} p.p.
    </span>
  );
}

/**
 * Cidade em destaque e cidade que precisa de atenção (GET /api/dashboard/cidades-desempenho): taxa
 * de uso pelo extrato contra o período anterior, com a classificação vinda do servidor.
 */
export default function CidadesDesempenhoCard() {
  const navigate = useNavigate();
  const [data, setData] = useState<Resp | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [criando, setCriando] = useState<string | null>(null);

  useEffect(() => {
    api<Resp>("/dashboard/cidades-desempenho").then(setData).catch(() => setData(null));
  }, []);

  if (!data) return null;

  async function campanhaAbertura(c: Cidade) {
    setCriando(c.cidadeKey);
    setErro(null);
    try {
      const r = await api<{ total: number; clientIds: string[]; mensagem: string }>(`/ciclos/audiencia?cidadeKey=${encodeURIComponent(c.cidadeKey)}`);
      if (r.total === 0) return setErro("Nenhum cliente apto a receber nesta cidade.");
      navigate("/campaigns/new", { state: { presetClientIds: r.clientIds, presetLabel: `Ciclo ${c.cidade}`, presetMessage: r.mensagem } });
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setCriando(null);
    }
  }

  if (!data.disponivel) {
    return (
      <div className="card pd-card" style={{ flex: "1 1 100%" }}>
        <h3>Cidades: destaque e atenção</h3>
        <p className="pd-card-sub">Importe o extrato de compras (aba "Todas as Compras") para comparar o uso entre as cidades.</p>
      </div>
    );
  }

  const Destaque = ({ c, tipo }: { c: Cidade | null; tipo: "ok" | "ruim" }) => {
    const cor = tipo === "ok" ? "var(--success)" : "var(--danger)";
    const fundo = tipo === "ok" ? "var(--success-soft)" : "var(--danger-soft)";
    return (
      <div style={{ flex: "1 1 320px", minWidth: 0, padding: 14, borderRadius: 12, border: `1px solid ${cor}`, background: fundo }}>
        <div className="pd-label" style={{ color: cor, marginBottom: 4 }}>{tipo === "ok" ? "Em destaque" : "Precisa de atenção"}</div>
        {c ? (
          <>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{c.cidade}</div>
            <div className="pd-card-sub" style={{ margin: "4px 0 0" }}>{c.motivo}</div>
            {tipo === "ruim" && c.clientesEmJogo > 0 && <div className="pd-hint">Cerca de {intFmt.format(c.clientesEmJogo)} clientes em jogo.</div>}
            {tipo === "ruim" && c.abreEmDias !== null && c.abreEmDias <= 7 && (
              <button className="btn" style={{ marginTop: 8 }} disabled={criando !== null} onClick={() => campanhaAbertura(c)}>
                {criando === c.cidadeKey ? "Carregando..." : `Campanha de abertura (abre em ${c.abreEmDias} dia${c.abreEmDias === 1 ? "" : "s"})`}
              </button>
            )}
          </>
        ) : (
          <div className="pd-card-sub" style={{ margin: 0 }}>{tipo === "ok" ? "Nenhuma cidade com alta relevante no período." : "Nenhuma cidade com queda ou nível preocupante."}</div>
        )}
      </div>
    );
  };

  return (
    <div className="card pd-card" style={{ flex: "1 1 100%" }}>
      <h3>Cidades: destaque e atenção</h3>
      <p className="pd-card-sub">
        Clientes com limite que usaram o cartão (antecipação ou compra à vista) nos 30 dias até {dia(data.ultimoDiaExtrato!)}, contra os 30 anteriores.
        {data.mediana !== null && ` Mediana das cidades: ${p1(data.mediana)}%.`} Cidades com menos de 30 clientes ou 30 usos ficam como "poucos dados".
      </p>
      {data.extratoEmDia === false && (
        <p className="pd-note" style={{ margin: "0 0 10px", color: "var(--warning)" }}>
          O extrato está parado há {data.diasDefasagem} dias: a comparação vale para o período até {dia(data.ultimoDiaExtrato!)}, não para hoje.
        </p>
      )}
      {erro && <div className="error-text" style={{ marginBottom: 10 }}>{erro}</div>}

      <div className="pd-row" style={{ marginBottom: 14 }}>
        <Destaque c={data.emDestaque} tipo="ok" />
        <Destaque c={data.precisaAtencao} tipo="ruim" />
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", minWidth: 640 }}>
          <thead>
            <tr>
              <th>Cidade</th>
              <th>Clientes</th>
              <th>Taxa de uso</th>
              <th>Variação</th>
              <th>Inativos</th>
              <th>Situação</th>
            </tr>
          </thead>
          <tbody>
            {data.cidades.map((c) => (
              <tr key={c.cidadeKey}>
                <td>
                  <Link to={`/clients?cidade=${encodeURIComponent(c.cidade)}`}>{c.cidade}</Link>
                </td>
                <td>{intFmt.format(c.clientes)}</td>
                <td>{c.taxaUso === null ? "—" : `${p1(c.taxaUso)}%`}</td>
                <td><Variacao pp={c.variacaoPp} /></td>
                <td>
                  <Link to={`/clients?cidade=${encodeURIComponent(c.cidade)}&statusConta=INATIVO`}>{intFmt.format(c.inativos)}</Link>
                </td>
                <td>
                  <span className="badge" style={{ color: SITUACAO[c.situacao].cor, borderColor: SITUACAO[c.situacao].cor }} title={c.motivo}>
                    {SITUACAO[c.situacao].label}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

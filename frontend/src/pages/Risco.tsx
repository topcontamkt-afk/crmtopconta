import { Fragment, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";

type Nivel = "alto" | "medio" | "todos";
interface Motivo {
  key: string;
  pontos: number;
  texto: string;
}
interface Cliente {
  id: string;
  nome: string;
  telefone: string;
  cidade: string | null;
  nota: number;
  nivel: "alto" | "medio" | "baixo";
  principal: string | null;
  motivos: Motivo[];
  confianca: "alta" | "media" | "baixa";
  diasSemUso: number;
  intervaloNormalDias: number;
  saldoDisponivel: number;
  lucroMensal: number;
}
interface Resp {
  disponivel: boolean;
  ultimoDiaExtrato?: string;
  extratoEmDia?: boolean;
  diasDefasagem?: number | null;
  cortes?: { alto: number; medio: number };
  resumo?: { avaliados: number; altos: number; medios: number; lucroMensalEmRisco: number };
  porCidade?: { cidade: string; altos: number; avaliados: number; pct: number }[];
  clientes?: Cliente[];
  totalFiltrado?: number;
}

const intFmt = new Intl.NumberFormat("pt-BR");
const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const brl2 = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dia = (iso: string) => iso.split("-").reverse().join("/");
const COR = { alto: "var(--danger)", medio: "var(--warning)", baixo: "var(--text-muted)" } as const;
const CONF = { alta: "alta", media: "média", baixa: "baixa" } as const;

const PESOS = [
  ["Dias sem uso contra o intervalo normal do cliente", 35],
  ["Queda de frequência (30 dias contra os 60 anteriores)", 25],
  ["Saldo alto parado, já estando atrasado", 15],
  ["O ciclo da cidade abriu e ele não usou", 15],
  ["Recebeu mensagens e não respondeu", 10],
] as const;

/** Risco de abandono por cliente: nota por regras (services/riscoAbandono.ts). GET /api/negocio/risco. */
export default function Risco() {
  const navigate = useNavigate();
  const [nivel, setNivel] = useState<Nivel>("alto");
  const [data, setData] = useState<Resp | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [criando, setCriando] = useState(false);
  const [aberto, setAberto] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    api<Resp>(`/negocio/risco?nivel=${nivel}&limite=100`).then(setData).catch((e) => setErro(e.message));
  }, [nivel]);

  async function criarCampanha() {
    setCriando(true);
    setErro(null);
    try {
      const r = await api<{ total: number; autorizados: number; clientIds: string[]; mensagem: string | null }>(`/negocio/risco/audiencia?nivel=${nivel}`);
      if (r.autorizados === 0) return setErro(r.total === 0 ? "Nenhum cliente nesta lista." : "Nenhum cliente desta lista pode receber campanha (sem autorização ou em opt-out).");
      navigate("/campaigns/new", { state: { presetClientIds: r.clientIds, presetLabel: `Risco de abandono (${nivel})`, presetMessage: r.mensagem ?? undefined } });
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setCriando(false);
    }
  }

  return (
    <div className="pd">
      <div className="pd-head">
        <div>
          <h2 style={{ margin: 0 }}>Risco de abandono</h2>
          <p className="pd-sub">Quais clientes que já usaram têm maior chance de parar de usar, e quanto lucro isso põe em risco.</p>
        </div>
        <div className="pd-seg" role="group" aria-label="Nível de risco">
          {([["alto", "Risco alto"], ["medio", "Risco médio"], ["todos", "Alto e médio"]] as [Nivel, string][]).map(([v, l]) => (
            <button key={v} type="button" className={nivel === v ? "on" : ""} aria-pressed={nivel === v} onClick={() => setNivel(v)}>{l}</button>
          ))}
        </div>
      </div>
      {erro && <div className="error-text">{erro}</div>}

      <div className="card pd-card" style={{ borderColor: "var(--warning)", background: "var(--warning-soft)" }}>
        <span style={{ fontSize: 13 }}>
          <strong style={{ color: "var(--warning)" }}>Estimativa por regras, não um modelo estatístico.</strong> A nota (0 a 100) soma cinco sinais do extrato e das campanhas, com pesos fixos. Só pontua quem já usou o cartão e tem limite.
          {data && data.extratoEmDia === false && ` O extrato está parado há ${data.diasDefasagem} dias: a nota vale até ${dia(data.ultimoDiaExtrato!)} e a confiança fica baixa.`}
        </span>
      </div>

      {!data && !erro && <div className="pd-skel" style={{ height: 240 }} />}
      {data && !data.disponivel && <div className="card pd-card"><p className="pd-card-sub">Importe o extrato de compras para calcular o risco.</p></div>}

      {data?.disponivel && data.resumo && data.cortes && (
        <>
          <div className="pd-kpis">
            <div className="pd-kpi"><div className="pd-kpi-label">Risco alto (nota {data.cortes.alto}+)</div><div className="pd-kpi-value" style={{ color: COR.alto }}>{intFmt.format(data.resumo.altos)}</div></div>
            <div className="pd-kpi"><div className="pd-kpi-label">Risco médio (nota {data.cortes.medio} a {data.cortes.alto - 1})</div><div className="pd-kpi-value" style={{ color: COR.medio }}>{intFmt.format(data.resumo.medios)}</div></div>
            <div className="pd-kpi"><div className="pd-kpi-label">Lucro mensal em risco</div><div className="pd-kpi-value">{brl.format(data.resumo.lucroMensalEmRisco)}</div><div className="pd-kpi-sub">média dos juros dos últimos 90 dias dos de risco alto</div></div>
            <div className="pd-kpi"><div className="pd-kpi-label">Clientes avaliados</div><div className="pd-kpi-value">{intFmt.format(data.resumo.avaliados)}</div><div className="pd-kpi-sub">já usaram e têm limite</div></div>
          </div>

          <div className="pd-row">
            <div className="card pd-card pd-grow-1">
              <h3>Como a nota é calculada</h3>
              <p className="pd-card-sub">Peso máximo de cada sinal.</p>
              {PESOS.map(([t, p]) => (
                <div key={t} className="pd-bar-row">
                  <div className="pd-bar-head"><span>{t}</span><span>{p}</span></div>
                  <div className="pd-track"><div className="pd-fill" style={{ width: `${p * 2.5}%`, background: "#ff6907" }} /></div>
                </div>
              ))}
            </div>
            <div className="card pd-card pd-grow-1">
              <h3>Risco alto por cidade</h3>
              <p className="pd-card-sub">Quantos clientes de risco alto e que parte dos avaliados da cidade.</p>
              {(data.porCidade ?? []).map((c) => (
                <div key={c.cidade} className="pd-bar-row">
                  <div className="pd-bar-head"><span>{c.cidade}</span><span>{intFmt.format(c.altos)} · {c.pct}%</span></div>
                  <div className="pd-track"><div className="pd-fill" style={{ width: `${Math.max(c.pct, 1.5)}%`, background: c.pct >= 50 ? "#e15b5b" : "#e0a233" }} /></div>
                </div>
              ))}
              {(data.porCidade ?? []).length === 0 && <p className="pd-card-sub">Nenhuma cidade com risco alto.</p>}
            </div>
          </div>

          <div className="card pd-card">
            <div className="pd-card-head">
              <div>
                <h3 style={{ margin: 0 }}>Clientes com maior risco</h3>
                <p className="pd-card-sub" style={{ margin: "4px 0 0" }}>{intFmt.format(data.totalFiltrado ?? 0)} no filtro; mostrando os {data.clientes?.length ?? 0} de maior nota. Telefone mascarado.</p>
              </div>
              <button className="btn" disabled={criando || (data.totalFiltrado ?? 0) === 0} onClick={criarCampanha}>{criando ? "Carregando..." : "Criar campanha com esta lista"}</button>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", minWidth: 860 }}>
                <thead>
                  <tr><th>Cliente</th><th>Cidade</th><th>Nota</th><th>Sem uso</th><th>Intervalo normal</th><th>Saldo</th><th>Lucro/mês</th><th>Motivo principal</th></tr>
                </thead>
                <tbody>
                  {(data.clientes ?? []).map((c) => (
                    <Fragment key={c.id}>
                      <tr style={{ cursor: "pointer" }} onClick={() => setAberto(aberto === c.id ? null : c.id)}>
                        <td>
                          <Link to={`/clients/${c.id}`} onClick={(e) => e.stopPropagation()}>{c.nome}</Link>
                          <div className="pd-hint">{c.telefone}</div>
                        </td>
                        <td>{c.cidade ?? "—"}</td>
                        <td><span className="badge" style={{ color: COR[c.nivel], borderColor: COR[c.nivel] }} title={`Confiança ${CONF[c.confianca]}`}>{c.nota}</span></td>
                        <td>{c.diasSemUso} dias</td>
                        <td>{c.intervaloNormalDias} dias</td>
                        <td>{brl2.format(c.saldoDisponivel)}</td>
                        <td>{brl2.format(c.lucroMensal)}</td>
                        <td style={{ fontSize: 13 }}>{c.principal ?? "—"}</td>
                      </tr>
                      {aberto === c.id && (
                        <tr>
                          <td colSpan={8} style={{ background: "var(--surface-alt)" }}>
                            <div style={{ fontSize: 13, padding: "4px 0" }}>
                              {c.motivos.map((m) => <div key={m.key}>+{m.pontos} · {m.texto}</div>)}
                              <div className="pd-hint">Confiança {CONF[c.confianca]}.</div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                  {(data.clientes ?? []).length === 0 && <tr><td colSpan={8} style={{ color: "var(--text-muted)" }}>Nenhum cliente neste nível.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

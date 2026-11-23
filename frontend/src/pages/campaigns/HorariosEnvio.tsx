import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "../../api/client";

type Tipo = "todos" | "antecipacao" | "compra";
type Por = "perfil" | "cidade" | "nenhum";
type Confianca = "alta" | "media" | "baixa";

interface Sugestao {
  horario: string;
  picoHora: number;
  antecedenciaMin: number;
  ajustadoPelaJanela: boolean;
  confianca: Confianca;
}
interface Segmento {
  key: string;
  label: string;
  clientes: number;
  usos: number;
  porHora: number[];
  picoHora: number | null;
  poucosDados: boolean;
  sugestao: Sugestao | null;
}
interface Resp {
  disponivel: boolean;
  motivo?: "SEM_EXTRATO";
  periodo: { ate: string; dias: number };
  extratoEmDia: boolean;
  diasDefasagem: number | null;
  total: { usos: number; porHora: number[]; picoHora: number | null; sugestao: Sugestao | null };
  segmentos: Segmento[];
  antecedencia: { fonte: "medida" | "padrao"; medianaMin: number; p25Min: number | null; p75Min: number | null; amostra: number };
  envios: { total: number; porHora: number[] };
}

const FAIXAS: { label: string; horas: number[] }[] = [
  { label: "6–8h", horas: [6, 7] },
  { label: "8–10h", horas: [8, 9] },
  { label: "10–12h", horas: [10, 11] },
  { label: "12–14h", horas: [12, 13] },
  { label: "14–16h", horas: [14, 15] },
  { label: "16–18h", horas: [16, 17] },
  { label: "18–20h", horas: [18, 19] },
  { label: "20–22h", horas: [20, 21] },
];
const CONFIANCA_LABEL: Record<Confianca, string> = { alta: "Confiança alta", media: "Confiança média", baixa: "Confiança baixa" };
const intFmt = new Intl.NumberFormat("pt-BR");
const p1 = (n: number) => n.toFixed(1).replace(".", ",");
const dia = (iso: string) => iso.split("-").reverse().join("/");

/**
 * Melhor horário de disparo: quando os clientes usam o cartão (pelo extrato) e o envio sugerido por
 * segmento. A antecedência é medida pelo tempo entre o envio e o 1º uso; sem amostra, é um padrão
 * e a tela diz que é estimativa. GET /api/dashboard/horarios.
 */
export default function HorariosEnvio() {
  const [tipo, setTipo] = useState<Tipo>("todos");
  const [por, setPor] = useState<Por>("perfil");
  const [data, setData] = useState<Resp | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    setErro(null);
    api<Resp>(`/dashboard/horarios?tipo=${tipo}&por=${por}`)
      .then(setData)
      .catch((e) => setErro(e.message));
  }, [tipo, por]);

  const Opcoes = <T extends string>({ valor, set, itens, rotulo }: { valor: T; set: (v: T) => void; itens: [T, string][]; rotulo: string }) => (
    <div className="pd-seg" role="group" aria-label={rotulo}>
      {itens.map(([v, l]) => (
        <button key={v} type="button" className={valor === v ? "on" : ""} aria-pressed={valor === v} onClick={() => set(v)}>{l}</button>
      ))}
    </div>
  );

  const chart = data?.disponivel
    ? data.total.porHora.map((usos, hora) => ({ hora: `${hora}h`, usos, pico: hora === data.total.picoHora }))
    : [];
  const horasDeEnvio = data?.envios.porHora.filter((n) => n > 0).length ?? 0;
  const maxCelula = data?.disponivel
    ? Math.max(1, ...data.segmentos.filter((s) => !s.poucosDados && s.clientes > 0).flatMap((s) => FAIXAS.map((f) => (f.horas.reduce((a, h) => a + s.porHora[h], 0) / s.clientes) * 100)))
    : 1;

  return (
    <div className="pd">
      <div className="pd-head">
        <div>
          <h2 style={{ margin: 0 }}>Melhor horário de disparo</h2>
          <p className="pd-sub">Quando os clientes usam o cartão e quanto antes enviar, por segmento. <Link to="/campaigns">Voltar para campanhas</Link></p>
        </div>
        <div className="pd-filters">
          <Opcoes valor={tipo} set={setTipo} rotulo="Tipo de uso" itens={[["todos", "Os dois"], ["antecipacao", "Saque (antecipação)"], ["compra", "Compra à vista"]]} />
          <Opcoes valor={por} set={setPor} rotulo="Segmentar por" itens={[["perfil", "Perfil de renda"], ["cidade", "Cidade"], ["nenhum", "Todos"]]} />
        </div>
      </div>

      {erro && <div className="error-text">{erro}</div>}
      {!data && !erro && <div className="pd-skel" style={{ height: 240 }} />}
      {data && !data.disponivel && (
        <div className="card pd-card">
          <h3>Sem extrato de compras</h3>
          <p className="pd-card-sub">Importe a aba "Todas as Compras" para ver os horários de uso.</p>
        </div>
      )}

      {data?.disponivel && (
        <>
          {data.antecedencia.fonte === "padrao" && (
            <div className="card pd-card" style={{ borderColor: "var(--warning)", background: "var(--warning-soft)" }}>
              <strong style={{ color: "var(--warning)" }}>Estimativa pelo uso.</strong>{" "}
              <span style={{ fontSize: 13 }}>
                Só há {data.antecedencia.amostra} envios com uso posterior medido (mínimo 30), então a antecedência usa o padrão de {data.antecedencia.medianaMin} min e o horário vem do pico de uso, não de testes de envio.
                {horasDeEnvio <= 1 && " Todos os envios saíram na mesma faixa de horário: para descobrir o melhor horário, dispare em 2 ou 3 horários com grupo de controle."}
              </span>
            </div>
          )}
          {!data.extratoEmDia && (
            <p className="pd-note" style={{ color: "var(--warning)" }}>
              O extrato está parado há {data.diasDefasagem} dias: os horários valem para os {data.periodo.dias} dias até {dia(data.periodo.ate)}.
            </p>
          )}

          <div className="pd-row">
            <div className="card pd-card pd-grow-2">
              <h3>Usos por hora do dia</h3>
              <p className="pd-card-sub">Horário de Brasília, {intFmt.format(data.total.usos)} usos nos {data.periodo.dias} dias até {dia(data.periodo.ate)}. Pico em laranja.</p>
              <div style={{ height: 220 }}>
                <ResponsiveContainer>
                  <BarChart data={chart} margin={{ top: 4, right: 4, bottom: 0, left: -12 }}>
                    <XAxis dataKey="hora" tick={{ fill: "#9aa4b8", fontSize: 11 }} interval={1} stroke="#2a3346" />
                    <YAxis tick={{ fill: "#9aa4b8", fontSize: 11 }} stroke="#2a3346" />
                    <Tooltip contentStyle={{ background: "#121826", border: "1px solid #232b3d", borderRadius: 8 }} formatter={(v) => [intFmt.format(Number(v)), "usos"]} />
                    <Bar dataKey="usos" radius={[4, 4, 0, 0]}>
                      {chart.map((c, i) => (
                        <Cell key={i} fill={c.pico ? "#ff6907" : "#4f7cff"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="card pd-card pd-grow-1">
              <h3>Horário sugerido</h3>
              <p className="pd-card-sub">Início do pico menos a antecedência, dentro da janela de 7h às 21h.</p>
              {data.total.sugestao ? (
                <div className="pd-opp">
                  <span className="pd-opp-n" style={{ color: "var(--accent)", background: "var(--accent-soft)" }}>{data.total.sugestao.horario}</span>
                  <div className="pd-opp-text">
                    <strong>Todos os clientes</strong>
                    <span>Pico às {data.total.sugestao.picoHora}h, {data.total.sugestao.antecedenciaMin} min de antecedência.{data.total.sugestao.ajustadoPelaJanela && " Ajustado para a janela comercial."}</span>
                    <span className="pd-hint">{CONFIANCA_LABEL[data.total.sugestao.confianca]}</span>
                  </div>
                </div>
              ) : (
                <p className="pd-card-sub">Poucos usos no período para sugerir um horário.</p>
              )}
              <div className="pd-label" style={{ marginTop: 14 }}>Antecedência</div>
              <p style={{ margin: 0, fontSize: 13 }}>
                {data.antecedencia.fonte === "medida"
                  ? `Mediana de ${data.antecedencia.medianaMin} min até o 1º uso (25% em ${data.antecedencia.p25Min} min, 75% em ${data.antecedencia.p75Min} min), em ${intFmt.format(data.antecedencia.amostra)} envios.`
                  : `Padrão de ${data.antecedencia.medianaMin} min (sem medição).`}
              </p>
            </div>
          </div>

          {por !== "nenhum" && (
            <>
              <div className="card pd-card">
                <h3>Recomendação por segmento</h3>
                <p className="pd-card-sub">Segmentos com menos de 30 usos no período aparecem como "poucos dados".</p>
                <div className="pd-opps">
                  {data.segmentos.map((s) => (
                    <div key={s.key} className="pd-opp">
                      <span className="pd-opp-n" style={{ color: s.sugestao ? "var(--accent)" : "var(--text-muted)", background: s.sugestao ? "var(--accent-soft)" : "var(--surface-alt)" }}>
                        {s.sugestao ? s.sugestao.horario : "—"}
                      </span>
                      <div className="pd-opp-text">
                        <strong>{s.label}</strong>
                        <span>
                          {s.sugestao
                            ? `Pico às ${s.sugestao.picoHora}h · ${intFmt.format(s.usos)} usos · ${intFmt.format(s.clientes)} clientes${s.sugestao.ajustadoPelaJanela ? " · ajustado para a janela comercial" : ""}`
                            : `Poucos dados (${intFmt.format(s.usos)} usos).`}
                        </span>
                        {s.sugestao && <span className="pd-hint">{CONFIANCA_LABEL[s.sugestao.confianca]}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="card pd-card">
                <h3>Segmento × horário</h3>
                <p className="pd-card-sub">Usos por 100 clientes do segmento em cada faixa de 2 horas. Quanto mais forte a cor, maior o uso.</p>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", minWidth: 640, borderCollapse: "separate", borderSpacing: 3 }}>
                    <thead>
                      <tr>
                        <th>Segmento</th>
                        {FAIXAS.map((f) => <th key={f.label} style={{ textAlign: "center" }}>{f.label}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {data.segmentos.map((s) => (
                        <tr key={s.key}>
                          <td style={{ whiteSpace: "nowrap" }}>{s.label}</td>
                          {FAIXAS.map((f) => {
                            if (s.poucosDados || s.clientes === 0) return <td key={f.label} style={{ textAlign: "center", color: "var(--text-muted)" }}>–</td>;
                            const v = (f.horas.reduce((a, h) => a + s.porHora[h], 0) / s.clientes) * 100;
                            const forca = v / maxCelula;
                            return (
                              <td key={f.label} style={{ textAlign: "center", borderRadius: 6, fontWeight: 600, background: `rgba(79,124,255,${0.12 + forca * 0.7})`, color: forca > 0.5 ? "#fff" : "var(--text)" }}>
                                {p1(v)}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

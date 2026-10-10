import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, downloadFile } from "../../api/client";

type SaldoGroup = "COM_SALDO" | "SEM_SALDO" | "DESCONHECIDO";

interface WindowStats {
  n: number;
  convertidos: number;
  taxa: number;
  usos: number;
  antecipacoes: { qtd: number; valor: number; lucro: number };
  compras: { qtd: number; valor: number };
  valorMovimentado: number;
  lucro: number;
}
interface CurvePoint extends WindowStats {
  dia: number;
  maduros: number;
}
interface CohortCurves {
  total: CurvePoint[];
  porSaldo: Record<SaldoGroup, CurvePoint[]>;
  porSaldoN: Record<SaldoGroup, number>;
}
interface LiftPoint {
  dia: number;
  taxaTratados: number;
  taxaControle: number;
  liftPontos: number;
  pValue: number | null;
  significativo95: boolean;
  dadosInsuficientes: boolean;
  lucroIncremental: number;
}
interface Resultados {
  minSaldoElegivel: number;
  tratados: CohortCurves;
  controle: CohortCurves | null;
  lift: { total: LiftPoint[]; comSaldo: LiftPoint[] } | null;
}
interface UsuarioQueUsou {
  nome: string;
  cidade: string | null;
  grupoSaldo: SaldoGroup;
  primeiroUsoEm: string;
  diaPrimeiroUso: number;
  usos: { tipo: "ANTECIPACAO" | "COMPRA"; valor: number; lucro: number | null; em: string }[];
  valorMovimentado: number;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const brl = (x: number) => `R$ ${Number(x).toFixed(2)}`;
const SALDO_LABEL: Record<SaldoGroup, string> = {
  COM_SALDO: "Com saldo no envio",
  SEM_SALDO: "Sem saldo no envio",
  DESCONHECIDO: "Saldo desconhecido",
};

interface Report {
  campaignId: string;
  isSandbox: boolean;
  audienceCount: number | null;
  porStatus: { status: string; count: number }[];
  conversoes: number;
  taxaConversao: string;
  custoTotal: number;
  valorGerado: number;
  valorMovimentado: number;
  roi: string | null;
  lucroIncremental: number | null;
  roiIncremental: string | null;
  controleEnviados: number;
  resultados: Resultados;
  usuarios: UsuarioQueUsou[];
  janelaAtribuicaoDias: number;
  variantBreakdown: { variant: string; enviados: number; conversoes: number; taxaConversao: string }[] | null;
  abSignificance: {
    conversionRateA: number;
    conversionRateB: number;
    pValue: number | null;
    zScore: number | null;
    significant95: boolean;
    insufficientData: boolean;
  } | null;
}

/** Curva de uso após o disparo (acumulada), com quem tinha saldo e o grupo de controle. */
function UsageCurve({ resultados, janelaDias }: { resultados: Resultados; janelaDias: number }) {
  const { tratados, controle, lift } = resultados;
  if (tratados.total[0].n === 0) {
    return (
      <div className="card" style={{ marginTop: 16 }}>
        <h3>Uso do limite depois do disparo</h3>
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Ainda não há envios concluídos para medir.</p>
      </div>
    );
  }
  const comSaldo = tratados.porSaldo.COM_SALDO;
  const temSaldo = tratados.porSaldoN.COM_SALDO > 0;
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>Uso do limite depois do disparo (acumulado)</h3>
      <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
        Conta como uso só antecipação e compra — assinatura não. D0 = no mesmo dia do envio, D7 = até 7 dias
        depois, e assim por diante (dias de calendário). Se o cliente recebeu outra campanha depois, o uso conta
        para a mais recente. Cabeçalho da página usa a janela de {janelaDias} dias da campanha.
      </p>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Até o dia</th>
              <th>Usaram</th>
              <th>Taxa (todos)</th>
              {temSaldo && <th>Taxa (só com saldo)</th>}
              <th>Valor movimentado</th>
              <th>Lucro (Juros)</th>
              {controle && <th>Controle (taxa)</th>}
              {lift && <th>Lift real</th>}
            </tr>
          </thead>
          <tbody>
            {tratados.total.map((p, i) => {
              const parcial = p.maduros < p.n;
              const l = lift?.comSaldo[i]?.dadosInsuficientes === false && temSaldo ? lift.comSaldo[i] : lift?.total[i];
              return (
                <tr key={p.dia}>
                  <td>
                    D{p.dia}
                    {parcial && (
                      <span title={`Só ${p.maduros} de ${p.n} envios já completaram ${p.dia} dia(s) — o número ainda vai subir`} style={{ color: "var(--text-muted)" }}>
                        {" "}*
                      </span>
                    )}
                  </td>
                  <td>{p.convertidos} de {p.n}</td>
                  <td>{pct(p.taxa)}</td>
                  {temSaldo && <td>{comSaldo[i].n > 0 ? pct(comSaldo[i].taxa) : "—"}</td>}
                  <td>{brl(p.valorMovimentado)}</td>
                  <td>{brl(p.lucro)}</td>
                  {controle && <td>{controle.total[i].n > 0 ? pct(controle.total[i].taxa) : "—"}</td>}
                  {lift && (
                    <td>
                      {l ? (
                        <>
                          {l.liftPontos > 0 ? "+" : ""}{l.liftPontos.toFixed(1)} p.p.{" "}
                          {l.dadosInsuficientes ? (
                            <span style={{ color: "var(--text-muted)" }}>(amostra pequena)</span>
                          ) : (
                            <span className={`badge ${l.significativo95 ? "ok" : ""}`}>{l.significativo95 ? "significativo" : "inconclusivo"}</span>
                          )}
                        </>
                      ) : "—"}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
        * ponto parcial: parte dos envios ainda não completou esse número de dias. Lucro = Juros das antecipações;
        compra à vista não tem lucro conhecido (a taxa é paga pelo comerciante), então fica fora do lucro e do ROI.
        {lift && " Lift real = taxa de uso de quem recebeu menos a de quem ficou de fora (controle), sobre quem tinha saldo quando possível."}
      </p>
    </div>
  );
}

/** Quem podia usar no dia do envio: sem saldo não há como converter, e não deve puxar a taxa para baixo. */
function SaldoBreakdown({ resultados }: { resultados: Resultados }) {
  const { tratados, minSaldoElegivel } = resultados;
  const total = tratados.total[0].n;
  if (total === 0) return null;
  const d7 = (g: SaldoGroup) => tratados.porSaldo[g].find((p) => p.dia === 7)!;
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>Quem tinha saldo na data do envio</h3>
      <table>
        <thead><tr><th>Grupo</th><th>Envios</th><th>Usaram até D7</th><th>Taxa até D7</th></tr></thead>
        <tbody>
          {(["COM_SALDO", "SEM_SALDO", "DESCONHECIDO"] as SaldoGroup[]).map((g) => (
            <tr key={g}>
              <td>{SALDO_LABEL[g]}</td>
              <td>{tratados.porSaldoN[g]}</td>
              <td>{d7(g).convertidos}</td>
              <td>{tratados.porSaldoN[g] > 0 ? pct(d7(g).taxa) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
        "Com saldo" = pelo menos R$ {minSaldoElegivel} disponíveis na data do envio (pelo histórico da planilha de
        contas). "Desconhecido" = o histórico ainda não existia nessa data (ele só começa na primeira importação de
        contas depois da atualização), então esse grupo tende a ser grande nas campanhas mais antigas.
      </p>
    </div>
  );
}

function WhoUsed({ usuarios }: { usuarios: UsuarioQueUsou[] }) {
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>Quem usou o limite (50 mais recentes)</h3>
      {usuarios.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Nenhum uso identificado ainda. A lista completa, com telefone, sai em "Exportar CSV".</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr><th>Cliente</th><th>Cidade</th><th>1º uso</th><th>Dia</th><th>Operações</th><th>Valor movimentado</th><th>Saldo no envio</th></tr>
            </thead>
            <tbody>
              {usuarios.map((u, i) => (
                <tr key={i}>
                  <td>{u.nome}</td>
                  <td>{u.cidade ?? "—"}</td>
                  <td>{new Date(u.primeiroUsoEm).toLocaleString("pt-BR")}</td>
                  <td>D{u.diaPrimeiroUso}</td>
                  <td>{u.usos.map((x) => (x.tipo === "ANTECIPACAO" ? "Antecipação" : "Compra")).join(", ")}</td>
                  <td>{brl(u.valorMovimentado)}</td>
                  <td>{SALDO_LABEL[u.grupoSaldo]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function CampaignReport() {
  const { id } = useParams();
  const [report, setReport] = useState<Report | null>(null);
  const [phones, setPhones] = useState("");
  const [testResult, setTestResult] = useState<string | null>(null);

  function load() {
    if (id) api<Report>(`/campaigns/${id}/report`).then(setReport);
  }
  useEffect(load, [id]);

  // Near-real-time (Fase 3 — recorte leve): sem WebSocket, mas a página se atualiza sozinha a
  // cada 20s enquanto a campanha ainda tem envios em andamento (evita ficar apertando F5).
  useEffect(() => {
    if (!id) return;
    const stillRunning = report ? report.porStatus.some((s) => s.status === "FILA") : true;
    if (!stillRunning) return;
    const interval = setInterval(load, 20000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, report?.porStatus]);

  async function sendTest() {
    if (!id) return;
    setTestResult("Enviando...");
    try {
      const resp = await api<{ results: { phone: string; status: string; provider: string }[] }>(
        `/campaigns/${id}/test-send`,
        { method: "POST", body: { phones: phones.split(",").map((p) => p.trim()).filter(Boolean) } }
      );
      setTestResult(resp.results.map((r) => `${r.phone}: ${r.status} (${r.provider})`).join(" · "));
    } catch (e) {
      setTestResult(e instanceof Error ? e.message : "Erro ao enviar teste");
    }
  }

  if (!report) return <div>Carregando...</div>;

  return (
    <div>
      <div className="topbar">
        <h2>Relatório da campanha {report.isSandbox && <span className="badge warn">Sandbox</span>}</h2>
        <button className="btn secondary" onClick={() => id && downloadFile(`/campaigns/${id}/report/export.csv`, `campanha-${id}.csv`)}>
          Exportar CSV
        </button>
      </div>

      <div className="grid-kpi">
        <div className="card">
          <div className="kpi-value">{report.audienceCount ?? "—"}</div>
          <div className="kpi-label">Público</div>
        </div>
        <div className="card">
          <div className="kpi-value">{report.conversoes}</div>
          <div className="kpi-label">Conversões (janela {report.janelaAtribuicaoDias}d)</div>
        </div>
        <div className="card">
          <div className="kpi-value">{report.taxaConversao}%</div>
          <div className="kpi-label">Taxa de conversão</div>
        </div>
        <div className="card">
          <div className="kpi-value">R$ {Number(report.custoTotal).toFixed(2)}</div>
          <div className="kpi-label">Custo total</div>
        </div>
        <div className="card">
          <div className="kpi-value">{brl(report.valorMovimentado)}</div>
          <div className="kpi-label">Valor movimentado (antecipação + compra)</div>
        </div>
        <div className="card">
          <div className="kpi-value">{brl(report.valorGerado)}</div>
          <div className="kpi-label">Lucro atribuído (Juros da antecipação)</div>
        </div>
        <div className="card">
          <div className="kpi-value">{report.roi ?? "—"}{report.roi ? "%" : ""}</div>
          <div className="kpi-label">ROI sobre o lucro</div>
        </div>
        {report.roiIncremental !== null && (
          <div className="card">
            <div className="kpi-value">{report.roiIncremental}%</div>
            <div className="kpi-label">ROI incremental (vs. grupo de controle)</div>
          </div>
        )}
      </div>

      <UsageCurve resultados={report.resultados} janelaDias={report.janelaAtribuicaoDias} />
      <SaldoBreakdown resultados={report.resultados} />
      <WhoUsed usuarios={report.usuarios} />


      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
        <div className="card">
          <h3>Status dos envios</h3>
          <table>
            <thead><tr><th>Status</th><th>Quantidade</th></tr></thead>
            <tbody>
              {report.porStatus.map((s) => (
                <tr key={s.status}><td>{s.status}</td><td>{s.count}</td></tr>
              ))}
            </tbody>
          </table>
        </div>

        {report.variantBreakdown && (
          <div className="card">
            <h3>A/B testing</h3>
            <table>
              <thead><tr><th>Variante</th><th>Enviados</th><th>Conversões</th><th>Taxa</th></tr></thead>
              <tbody>
                {report.variantBreakdown.map((v) => (
                  <tr key={v.variant}>
                    <td>{v.variant}</td><td>{v.enviados}</td><td>{v.conversoes}</td><td>{v.taxaConversao}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {report.abSignificance && (
              <div style={{ marginTop: 10, fontSize: 13 }}>
                {report.abSignificance.insufficientData ? (
                  <span style={{ color: "var(--text-muted)" }}>
                    Amostra ainda pequena (mín. 30 envios por variante) para uma conclusão estatística confiável.
                  </span>
                ) : (
                  <>
                    <span className={`badge ${report.abSignificance.significant95 ? "ok" : ""}`}>
                      {report.abSignificance.significant95 ? "Diferença estatisticamente significativa" : "Sem diferença significativa"}
                    </span>{" "}
                    <span style={{ color: "var(--text-muted)" }}>
                      (p-valor {report.abSignificance.pValue}, 95% de confiança)
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Sandbox / QA — enviar amostra de teste</h3>
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
          Envia a variante A diretamente para os números abaixo (dados de exemplo no lugar dos
          placeholders), sem afetar o público real nem os relatórios.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            style={{ flex: 1 }}
            placeholder="Telefones separados por vírgula, ex: +5511999998888, +5511988887777"
            value={phones}
            onChange={(e) => setPhones(e.target.value)}
          />
          <button className="btn secondary" onClick={sendTest}>Enviar teste</button>
        </div>
        {testResult && <p style={{ marginTop: 8, fontSize: 13 }}>{testResult}</p>}
      </div>
    </div>
  );
}

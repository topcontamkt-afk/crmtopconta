import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api, downloadFile } from "../../api/client";
import { executarDisparo } from "../../utils/disparo";
import { useAuth } from "../../context/AuthContext";

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

interface Cliques {
  enviados: number;
  clicaram: number;
  taxaClique: number;
  cliquesTotal: number;
  mesmoDia: number;
  mediaDiasAteClique: number | null;
  usaramEntreQuemClicou: number;
  clicouMedidos: number;
  taxaUsoQuemClicou: number | null;
  taxaUsoQuemNaoClicou: number | null;
}

interface FunilEtapa {
  chave: "publico" | "enviadas" | "entregues" | "visualizaram" | "clicaram" | "usaram";
  rotulo: string;
  valor: number;
  pctDoAnterior: number | null;
  pctDasEnviadas: number | null;
}
interface Funil {
  publico: number;
  naFila: number;
  enviadas: number;
  entregues: number;
  visualizaram: number;
  clicaram: number;
  responderam: number;
  falhas: number;
  bloqueadas: number;
  controle: number;
  usaram: number | null;
  etapas: FunilEtapa[];
}
interface AoVivo {
  status: string;
  emDisparo: boolean;
  funil: Funil;
  ultimos: { nome: string; telefone: string; status: string; em: string | null; erro: string | null }[];
  atualizadoEm: string;
}

interface Report {
  funil?: Funil;
  manual?: boolean;
  cliques?: Cliques | null;
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
  porCiclo?: { faixa: string; label: string; enviados: number; convertidos: number; taxaConversao: string; lucro: number; controle: number; taxaControle: number | null; liftPontos: number | null; significativo95: boolean | null }[];
  porPerfil?: { perfil: string; enviados: number; convertidos: number; taxaConversao: string; lucro: number; controle: number; taxaControle: number | null; liftPontos: number | null; significativo95: boolean | null }[];
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

const STATUS_ROTULO: Record<string, string> = { ENVIADO: "Enviada", ENTREGUE: "Entregue", LIDO: "Lida", RESPONDIDO: "Respondeu", FALHA: "Recusada", BLOQUEADO: "Bloqueada" };
const fmtPct = (v: number | null) => (v === null ? "—" : `${v.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`);

/** Pessoas na campanha, visualizaram, clicaram e a taxa de cada etapa do funil. */
function FunilCard({ funil, taxaConversao, janela }: { funil: Funil; taxaConversao: string; janela: number }) {
  const maximo = Math.max(funil.publico, 1);
  const enviadas = funil.enviadas;
  const taxaVis = enviadas > 0 ? (funil.visualizaram / enviadas) * 100 : null;
  const taxaCli = enviadas > 0 ? (funil.clicaram / enviadas) * 100 : null;
  return (
    <>
      <div className="grid-kpi">
        <div className="card">
          <div className="kpi-value">{funil.publico}</div>
          <div className="kpi-label">Pessoas na campanha</div>
        </div>
        <div className="card">
          <div className="kpi-value">{funil.visualizaram}</div>
          <div className="kpi-label">Visualizaram · {fmtPct(taxaVis)} das enviadas</div>
        </div>
        <div className="card">
          <div className="kpi-value">{funil.clicaram}</div>
          <div className="kpi-label">Clicaram no link · {fmtPct(taxaCli)} das enviadas</div>
        </div>
        <div className="card">
          <div className="kpi-value">{taxaConversao}%</div>
          <div className="kpi-label">Taxa de conversão (usaram o limite, {janela}d)</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Funil da campanha</h3>
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
          Cada barra é uma etapa; os percentuais mostram quantos passaram da etapa anterior e quantos das mensagens enviadas chegaram até ali. Quem clicou no link conta como entregue e visualizou,
          mesmo quando a pessoa desligou a confirmação de leitura.
        </p>
        <div style={{ display: "grid", gap: 10 }}>
          {funil.etapas.map((e) => (
            <div key={e.chave}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", fontSize: 13 }}>
                <strong>{e.rotulo}</strong>
                <span>
                  <strong>{e.valor}</strong>
                  {e.pctDoAnterior !== null && <span style={{ color: "var(--text-muted)" }}> · {fmtPct(e.pctDoAnterior)} da etapa anterior</span>}
                  {e.pctDasEnviadas !== null && <span style={{ color: "var(--text-muted)" }}> · {fmtPct(e.pctDasEnviadas)} das enviadas</span>}
                </span>
              </div>
              <div style={{ height: 10, background: "var(--border)", borderRadius: 5, marginTop: 4 }}>
                <div style={{ width: `${Math.min(100, (e.valor / maximo) * 100)}%`, height: 10, borderRadius: 5, background: "var(--success)", transition: "width .4s" }} />
              </div>
            </div>
          ))}
        </div>
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 10 }}>
          Na fila: {funil.naFila} · Recusadas pela Meta: {funil.falhas} · Bloqueadas: {funil.bloqueadas} · Responderam: {funil.responderam}
          {funil.controle > 0 && <> · Grupo de controle: {funil.controle}</>}
        </p>
      </div>
    </>
  );
}

/** Andamento do envio ao vivo: barra, últimas mensagens e os botões de parar/continuar. */
function EnvioAoVivo({ vivo, envio, aviso, onParar, onContinuar }: { vivo: AoVivo | null; envio: { restam: number; total: number; fase: string } | null; aviso: { tipo: "ok" | "erro"; texto: string } | null; onParar: () => void; onContinuar: () => void }) {
  const naFila = vivo?.funil.naFila ?? 0;
  const pendente = !!vivo && naFila > 0 && (vivo.status === "AGENDADA" || vivo.status === "EM_EXECUCAO");
  const concluido = !!vivo && naFila === 0 && vivo.funil.enviadas > 0;
  const feitas = envio ? Math.max(0, envio.total - envio.restam) : 0;
  const pctBarra = envio && envio.total > 0 ? Math.min(100, Math.round((feitas / envio.total) * 100)) : 0;
  if (!envio && !vivo?.emDisparo && !pendente && !concluido && !aviso) return null;
  return (
    <div className="card" style={{ marginBottom: 16, borderLeft: `4px solid ${envio || vivo?.emDisparo ? "var(--warning)" : concluido ? "var(--success)" : "var(--border)"}` }}>
      {envio ? (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <strong>Enviando… {feitas}/{envio.total}</strong>
            <button className="btn secondary" onClick={onParar}>Parar envio</button>
          </div>
          <div style={{ height: 8, background: "var(--border)", borderRadius: 4, margin: "8px 0" }}>
            <div style={{ width: `${pctBarra}%`, height: 8, borderRadius: 4, background: "var(--success)", transition: "width .4s" }} />
          </div>
          <div className="pd-hint">{envio.fase} Mantenha esta página aberta: o envio roda por ela. Parar não perde nada, dá para continuar depois.</div>
        </>
      ) : vivo?.emDisparo ? (
        <strong>Enviando em outra aba… acompanhando ao vivo.</strong>
      ) : pendente ? (
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <span>Restam <strong>{naFila}</strong> mensagens na fila.</span>
          <button className="btn" onClick={onContinuar}>{vivo!.funil.enviadas > 0 ? `Continuar envio (restam ${naFila})` : "Iniciar envio"}</button>
        </div>
      ) : concluido ? (
        <strong>Enviado ✓ {vivo!.funil.enviadas} mensagens.</strong>
      ) : null}
      {aviso && <div style={{ marginTop: 8, fontSize: 13, color: aviso.tipo === "ok" ? "var(--success)" : "var(--danger)" }}>{aviso.texto}</div>}
      {vivo && vivo.ultimos.length > 0 && (
        <div style={{ marginTop: 10, overflowX: "auto" }}>
          <div className="pd-hint" style={{ marginBottom: 4 }}>Últimas mensagens (atualiza sozinho)</div>
          <table>
            <thead><tr><th>Contato</th><th>Telefone</th><th>Situação</th><th>Hora</th></tr></thead>
            <tbody>
              {vivo.ultimos.map((u, i) => (
                <tr key={i}>
                  <td>{u.nome}</td>
                  <td>{u.telefone}</td>
                  <td>
                    {STATUS_ROTULO[u.status] ?? u.status}
                    {u.erro && <div className="pd-hint" style={{ color: "var(--warning)" }}>{u.erro}</div>}
                  </td>
                  <td>{u.em ? new Date(u.em).toLocaleTimeString("pt-BR") : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
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

/** Resultado por perfil de renda (PF1–PF4, estimado pelo limite atual do cliente). */
function PerfilBreakdown({ porPerfil, janelaDias }: { porPerfil: NonNullable<Report["porPerfil"]>; janelaDias: number }) {
  if (porPerfil.length === 0) return null;
  const temControle = porPerfil.some((p) => p.controle > 0);
  const brl = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>Resultado por perfil de renda</h3>
      <table>
        <thead>
          <tr>
            <th>Perfil</th><th>Envios</th><th>Usaram até D{janelaDias}</th><th>Taxa</th><th>Lucro (juros)</th>
            {temControle && <><th>Controle</th><th>Lift (p.p.)</th></>}
          </tr>
        </thead>
        <tbody>
          {porPerfil.map((p) => (
            <tr key={p.perfil}>
              <td>{p.perfil === "SEM_PERFIL" ? "Sem limite" : p.perfil}</td>
              <td>{p.enviados}</td>
              <td>{p.convertidos}</td>
              <td>{p.taxaConversao}%</td>
              <td>{brl(p.lucro)}</td>
              {temControle && (
                <>
                  <td>{p.controle > 0 ? `${p.controle} (${((p.taxaControle ?? 0) * 100).toFixed(1)}%)` : "—"}</td>
                  <td>{p.liftPontos === null ? "dados insuficientes" : `${p.liftPontos > 0 ? "+" : ""}${p.liftPontos}${p.significativo95 ? " ✓" : ""}`}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
        O perfil usa o limite atual do cliente (limite ÷ 0,40). Perfis com poucos envios oscilam muito: leia a
        taxa junto com o número de envios.
      </p>
    </div>
  );
}

/** Resultado pelo dia do ciclo da cidade em que o cliente estava ao receber: mensagem no começo do ciclo (limite renovado) x no fim. */
function CicloBreakdown({ porCiclo, janelaDias }: { porCiclo: NonNullable<Report["porCiclo"]>; janelaDias: number }) {
  // Só vale mostrar se houver ao menos um envio em cidade com ciclo cadastrado
  if (!porCiclo.some((p) => p.faixa !== "SEM_CICLO" && p.enviados > 0)) return null;
  const temControle = porCiclo.some((p) => p.controle > 0);
  const brl = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>Resultado por dia do ciclo no envio</h3>
      <table>
        <thead>
          <tr>
            <th>Momento do envio</th><th>Envios</th><th>Usaram até D{janelaDias}</th><th>Taxa</th><th>Lucro (juros)</th>
            {temControle && <><th>Controle</th><th>Lift (p.p.)</th></>}
          </tr>
        </thead>
        <tbody>
          {porCiclo.map((p) => (
            <tr key={p.faixa}>
              <td>{p.label}</td>
              <td>{p.enviados}</td>
              <td>{p.convertidos}</td>
              <td>{p.taxaConversao}%</td>
              <td>{brl(p.lucro)}</td>
              {temControle && (
                <>
                  <td>{p.controle > 0 ? `${p.controle} (${((p.taxaControle ?? 0) * 100).toFixed(1)}%)` : "—"}</td>
                  <td>{p.liftPontos === null ? "dados insuficientes" : `${p.liftPontos > 0 ? "+" : ""}${p.liftPontos}${p.significativo95 ? " ✓" : ""}`}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
        O dia do ciclo vem da cidade do cliente (cadastro em “Ciclos das cidades”) e do dia em que a mensagem saiu, em horário de Brasília. Grupos pequenos oscilam: leia a taxa junto com o número de envios.
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


interface Destinatario {
  id: string;
  nome: string;
  telefone: string;
  naBase: boolean;
  limiteDisponivel: number | null;
  status: string | null;
  erro: string | null;
  enviadoEm: string | null;
  usou: boolean | null;
  diasAteUso: number | null;
  primeiroUsoEm: string | null;
  valorMovimentado: number | null;
  clicouEm?: string | null;
  cliques?: number;
  diasAteClique?: number | null;
}

/** Lista da campanha manual: quem recebeu e, para clientes da base, se usou o limite e em quantos dias. */
function Destinatarios({ id }: { id: string }) {
  const [d, setD] = useState<{ total: number; naBase: number; foraDaBase: number; medidos: number; usaram: number; destinatarios: Destinatario[] } | null>(null);
  const [filtro, setFiltro] = useState<"todos" | "usaram" | "nao" | "fora">("todos");
  useEffect(() => {
    api<typeof d>(`/campaigns/${id}/destinatarios`).then(setD);
  }, [id]);
  if (!d) return null;
  const lista = d.destinatarios.filter((r) =>
    filtro === "usaram" ? r.usou : filtro === "nao" ? r.naBase && r.enviadoEm && !r.usou : filtro === "fora" ? !r.naBase : true
  );
  const brl = (n: number | null) => (n === null ? "—" : n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>Contatos da lista</h3>
      <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
        {d.total} contatos: {d.naBase} são clientes da base (medidos pelo uso real do cartão: {d.usaram} de {d.medidos} enviados já usaram) e {d.foraDaBase} estão fora da base.
        Quando um contato entrar na base por uma importação futura, ele passa a ser medido sozinho.
      </p>
      <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        {([["todos", "Todos"], ["usaram", "Usaram"], ["nao", "Ainda não usaram"], ["fora", "Fora da base"]] as const).map(([k, l]) => (
          <button key={k} className={`btn ${filtro === k ? "" : "secondary"}`} onClick={() => setFiltro(k)}>{l}</button>
        ))}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr><th>Nome</th><th>Telefone</th><th>Limite (lista)</th><th>Envio</th><th>Na base</th><th>Clicou?</th><th>Usou?</th><th>Dias até o uso</th><th>Valor</th></tr>
          </thead>
          <tbody>
            {lista.slice(0, 300).map((r) => (
              <tr key={r.id}>
                <td>{r.nome}</td>
                <td>{r.telefone}</td>
                <td>{brl(r.limiteDisponivel)}</td>
                <td>{r.status ?? "—"}{r.erro ? <span title={r.erro}> ⚠</span> : null}</td>
                <td>{r.naBase ? "Sim" : "Não"}</td>
                <td>{r.clicouEm ? (r.diasAteClique === 0 ? "Sim, no dia" : `Sim, ${r.diasAteClique} dia(s) depois`) : "—"}</td>
                <td>{!r.naBase ? "—" : r.usou === null ? "aguardando envio" : r.usou ? "Sim" : "Não"}</td>
                <td>{r.diasAteUso === null ? "—" : r.diasAteUso === 0 ? "No dia" : `${r.diasAteUso} dia(s)`}</td>
                <td>{brl(r.valorMovimentado)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {lista.length > 300 && <p style={{ fontSize: 12 }}>Mostrando 300 de {lista.length}. O CSV do relatório traz a lista completa.</p>}
    </div>
  );
}

/** Botão de link rastreado: quem clicou, quando e se quem clica usa mais o limite. */
function CliquesCard({ c, janela }: { c: Cliques; janela: number }) {
  const pct = (n: number | null) => (n === null ? "—" : `${n.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`);
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>Cliques no botão de link</h3>
      <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
        O link de cada cliente é único e passa por um endereço nosso. Prévia de link do WhatsApp e robôs não contam.
      </p>
      <div className="grid-kpi">
        <div className="card"><div className="kpi-value">{c.clicaram}</div><div className="kpi-label">Clicaram ({pct(c.taxaClique)} dos {c.enviados} enviados)</div></div>
        <div className="card"><div className="kpi-value">{c.cliquesTotal}</div><div className="kpi-label">Cliques no total</div></div>
        <div className="card"><div className="kpi-value">{c.mesmoDia}</div><div className="kpi-label">Clicaram no mesmo dia do envio</div></div>
        <div className="card"><div className="kpi-value">{c.mediaDiasAteClique === null ? "—" : c.mediaDiasAteClique.toLocaleString("pt-BR")}</div><div className="kpi-label">Dias até o clique (média)</div></div>
      </div>
      {c.clicouMedidos > 0 && (
        <p style={{ fontSize: 13, marginTop: 10 }}>
          Uso do limite em até {janela} dias: <strong>{pct(c.taxaUsoQuemClicou)}</strong> de quem clicou ({c.usaramEntreQuemClicou} de {c.clicouMedidos}) contra{" "}
          <strong>{pct(c.taxaUsoQuemNaoClicou)}</strong> de quem não clicou.
        </p>
      )}
    </div>
  );
}

function WhoUsed({ usuarios }: { usuarios: UsuarioQueUsou[] }) {
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>Quem usou o limite (50 mais recentes)</h3>
      {usuarios.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Nenhum uso identificado ainda. A lista completa sai em "Exportar CSV" (telefone mascarado; completo só para administradores, com motivo).</p>
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

/** Etapas ao vivo (envio/entrega/leitura/clique) mais "usaram o limite", que só vem do relatório completo. */
function juntarEtapas(vivo: Funil, completo?: Funil): FunilEtapa[] {
  const usaram = completo?.etapas.find((e) => e.chave === "usaram");
  return usaram ? [...vivo.etapas.filter((e) => e.chave !== "usaram"), { ...usaram, pctDasEnviadas: vivo.enviadas > 0 ? Number(((usaram.valor / vivo.enviadas) * 100).toFixed(1)) : null }] : vivo.etapas;
}

export default function CampaignReport() {
  const { id } = useParams();
  const { user } = useAuth();
  const [report, setReport] = useState<Report | null>(null);
  const [erroExport, setErroExport] = useState<string | null>(null);

  // LGPD 05-01: o CSV sai com o telefone mascarado; completo só para ADMIN, com motivo (no corpo, auditado)
  async function exportar(completo: boolean) {
    if (!id) return;
    setErroExport(null);
    let motivo = "";
    if (completo) {
      motivo = (window.prompt("Motivo para exportar o telefone completo (fica registrado na auditoria):") ?? "").trim();
      if (motivo.length < 5) {
        setErroExport("Informe o motivo (ao menos 5 caracteres) para exportar o telefone completo.");
        return;
      }
    }
    try {
      await downloadFile(`/campaigns/${id}/report/export.csv`, `campanha-${id}.csv`, { method: "POST", body: completo ? { completo: true, motivo } : {} });
    } catch (e) {
      setErroExport(e instanceof Error ? e.message : "Não foi possível exportar.");
    }
  }
  const [phones, setPhones] = useState("");
  const [testResult, setTestResult] = useState<string | null>(null);

  const [params, setParams] = useSearchParams();
  const [vivo, setVivo] = useState<AoVivo | null>(null);
  const [envio, setEnvio] = useState<{ restam: number; total: number; fase: string } | null>(null);
  const [avisoEnvio, setAvisoEnvio] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);
  const pararRef = useRef(false);
  const rodandoRef = useRef(false);
  const iniciouRef = useRef(false);

  function load() {
    if (id) api<Report>(`/campaigns/${id}/report`).then(setReport);
  }
  useEffect(load, [id]);

  const carregarVivo = useCallback(async () => {
    if (!id) return;
    try {
      setVivo(await api<AoVivo>(`/campaigns/${id}/funil`));
    } catch {
      /* a próxima consulta tenta de novo */
    }
  }, [id]);
  useEffect(() => void carregarVivo(), [carregarVivo]);

  // Enquanto envia (aqui ou em outra aba) o funil e as últimas mensagens se atualizam a cada poucos segundos
  const acompanhando = !!envio || !!vivo?.emDisparo;
  useEffect(() => {
    if (!acompanhando) return;
    const t = setInterval(() => void carregarVivo(), 2500);
    return () => clearInterval(t);
  }, [acompanhando, carregarVivo]);

  /** Roda o envio nesta página, um lote de cada vez (ver utils/disparo.ts). */
  async function iniciarEnvio() {
    if (!id || rodandoRef.current) return;
    rodandoRef.current = true;
    pararRef.current = false;
    setAvisoEnvio(null);
    try {
      const atual = await api<AoVivo>(`/campaigns/${id}/funil`);
      setVivo(atual);
      const total = atual.funil.naFila;
      if (total === 0) {
        setAvisoEnvio({ tipo: "ok", texto: "Não há mensagens na fila para enviar." });
        return;
      }
      setEnvio({ restam: total, total, fase: "Enviando…" });
      const r = await executarDisparo(id, {
        deveParar: () => pararRef.current,
        onRestam: (restam, fase) => {
          setEnvio((p) => (p ? { ...p, restam: restam < 0 ? p.restam : restam, fase } : p));
          void carregarVivo(); // o funil acompanha a barra a cada lote
        },
      });
      if (r.concluida) setAvisoEnvio({ tipo: "ok", texto: "Envio concluído." });
      else if (r.aviso) setAvisoEnvio({ tipo: "erro", texto: r.aviso });
      else setAvisoEnvio({ tipo: "ok", texto: "Envio parado. Use “Continuar envio” para retomar." });
    } catch (e) {
      setAvisoEnvio({ tipo: "erro", texto: `O envio parou: ${e instanceof Error ? e.message : "erro inesperado"}` });
    } finally {
      rodandoRef.current = false;
      setEnvio(null);
      await carregarVivo();
      load();
    }
  }

  // Vindo do botão de disparar ou do assistente (?enviar=1): começa o envio uma vez e limpa o endereço, para que
  // recarregar a página não dispare de novo
  useEffect(() => {
    if (!id || params.get("enviar") !== "1" || iniciouRef.current) return;
    iniciouRef.current = true;
    setParams({}, { replace: true });
    void iniciarEnvio();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, params]);

  function continuarEnvio() {
    const restam = vivo?.funil.naFila ?? 0;
    if (!window.confirm(`Enviar agora as ${restam} mensagens que restam? Quem já recebeu não recebe de novo.`)) return;
    void iniciarEnvio();
  }

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
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn secondary" onClick={() => exportar(false)} title="Telefone mascarado">
            Exportar CSV
          </button>
          {user?.role === "ADMIN" && (
            <button className="btn secondary" onClick={() => exportar(true)} title="Exige motivo; fica na auditoria">
              CSV com telefone completo
            </button>
          )}
        </div>
      </div>
      {erroExport && <p className="error-text">{erroExport}</p>}

      <EnvioAoVivo vivo={vivo} envio={envio} aviso={avisoEnvio} onParar={() => (pararRef.current = true)} onContinuar={continuarEnvio} />
      <FunilCard funil={vivo?.funil ? { ...vivo.funil, usaram: report.funil?.usaram ?? null, etapas: juntarEtapas(vivo.funil, report.funil) } : report.funil!} taxaConversao={report.taxaConversao} janela={report.janelaAtribuicaoDias} />

      <div className="grid-kpi">
        <div className="card">
          <div className="kpi-value">{report.conversoes}</div>
          <div className="kpi-label">Conversões (janela {report.janelaAtribuicaoDias}d)</div>
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
      <PerfilBreakdown porPerfil={report.porPerfil ?? []} janelaDias={report.janelaAtribuicaoDias} />
      <CicloBreakdown porCiclo={report.porCiclo ?? []} janelaDias={report.janelaAtribuicaoDias} />
      {report.cliques && <CliquesCard c={report.cliques} janela={report.janelaAtribuicaoDias} />}
      <WhoUsed usuarios={report.usuarios} />
      {report.manual && id && <Destinatarios id={id} />}


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

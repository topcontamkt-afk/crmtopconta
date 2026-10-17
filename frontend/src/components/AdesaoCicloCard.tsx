import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";

type Faixa = "SAUDAVEL" | "ATENCAO" | "BAIXA";
interface Medida {
  usaram: number;
  taxa: number | null;
  faixa: Faixa | null;
  faltam: number;
}
interface Resp {
  configurado: boolean;
  meta: number;
  hoje?: string;
  extrato?: { primeiro: string | null; ultimo: string | null };
  geral?: { base: number; completo: Medida & { cidades: number; base: number }; atual: Medida; completoCoberto: boolean };
  cidades: {
    cidade: string;
    diaAbertura: number;
    base: number;
    completo: Medida & { de: string; ate: string; coberto: boolean; semDados: boolean };
    atual: Medida & { de: string; ate: string; diaDoCiclo: number; coberto: boolean };
  }[];
}

const COR: Record<Faixa, string> = { SAUDAVEL: "#35c17a", ATENCAO: "#e0a233", BAIXA: "#e15b5b" };
const MUTED = "#9aa4b8";
const pctBr = (n: number) => `${n.toFixed(1).replace(".", ",")}%`;
const int = (n: number) => n.toLocaleString("pt-BR");
const br = (iso: string) => iso.slice(8, 10) + "/" + iso.slice(5, 7);

function Barra({ m, meta, nota }: { m: Medida; meta: number; nota?: string }) {
  const cor = m.faixa ? COR[m.faixa] : MUTED;
  return (
    <div>
      <div className="pd-bar-head" style={{ marginBottom: 3 }}>
        <span style={{ color: cor, fontWeight: 600 }}>{m.taxa !== null ? pctBr(m.taxa) : "—"}</span>
        <span>{nota ?? (m.faltam > 0 ? `faltam ${int(m.faltam)}` : "meta atingida")}</span>
      </div>
      <div className="pd-rec-track">
        <span className="pd-rec-fill" style={{ width: `${Math.min(100, m.taxa ?? 0)}%`, background: cor }} />
        <span className="pd-rec-meta" style={{ left: `${meta}%` }} />
      </div>
    </div>
  );
}

/**
 * Adesão ao saldo POR CICLO (meta 80% da base ativa): cada cidade tem o seu dia de abertura, então compara o último ciclo
 * completo de cada uma e mostra o ciclo em andamento (parcial: sobe até o fechamento).
 */
export default function AdesaoCicloCard({ cidade, convenio }: { cidade: string; convenio: string }) {
  const [d, setD] = useState<Resp | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    const qs = new URLSearchParams();
    if (cidade) qs.set("cidade", cidade);
    if (convenio) qs.set("empresaConveniada", convenio);
    let vivo = true;
    api<Resp>(`/dashboard/adesao-ciclo?${qs}`)
      .then((r) => vivo && (setD(r), setErro(null)))
      .catch((e) => vivo && setErro(e.message));
    return () => {
      vivo = false;
    };
  }, [cidade, convenio]);

  if (erro) return <div className="card pd-card error-text">Adesão por ciclo: {erro}</div>;
  if (!d) return null;
  if (!d.configurado) {
    return (
      <div className="card pd-card">
        <h3>Adesão por ciclo</h3>
        <p className="pd-card-sub">Cadastre o dia de abertura do ciclo de cada cidade para medir a adesão ao saldo por ciclo. <Link to="/ciclos">Cadastrar ciclos</Link></p>
      </div>
    );
  }
  const g = d.geral!;
  const semDadosCidades = d.cidades.filter((c) => c.completo.semDados);

  return (
    <div className="card pd-card">
      <div className="pd-card-head">
        <div>
          <h3>Adesão por ciclo (meta {d.meta}% da base ativa)</h3>
          <p className="pd-card-sub" style={{ marginBottom: 0 }}>
            Clientes ativos com limite que usaram o saldo em cada ciclo, com o dia de abertura de cada cidade. O ciclo atual ainda está em andamento: a taxa sobe até o fechamento.
          </p>
        </div>
      </div>

      <div className="pd-minis" style={{ marginBottom: 12 }}>
        <div className="pd-mini">
          <div className="pd-kpi-label">Último ciclo completo (geral)</div>
          <div className="pd-kpi-value" style={{ fontSize: 22, color: g.completo.faixa ? COR[g.completo.faixa] : undefined }}>
            {g.completo.taxa !== null ? pctBr(g.completo.taxa) : "—"}
          </div>
          <div className="pd-kpi-sub">
            {int(g.completo.usaram)} de {int(g.completo.base)} ({g.completo.cidades} de {d.cidades.length} cidades com dados) · {g.completo.faltam > 0 ? `faltam ${int(g.completo.faltam)} para ${d.meta}%` : "meta atingida"}
          </div>
        </div>
        <div className="pd-mini">
          <div className="pd-kpi-label">Ciclo atual, até agora (geral)</div>
          <div className="pd-kpi-value" style={{ fontSize: 22, color: g.atual.faixa ? COR[g.atual.faixa] : undefined }}>
            {g.atual.taxa !== null ? pctBr(g.atual.taxa) : "—"}
          </div>
          <div className="pd-kpi-sub">{int(g.atual.usaram)} de {int(g.base)} · parcial, cada cidade em um dia diferente do ciclo</div>
        </div>
      </div>

      {semDadosCidades.length > 0 && (
        <p className="pd-note" style={{ margin: "0 0 10px", color: "var(--warning)" }}>
          Sem dados do ciclo anterior em {semDadosCidades.map((c) => c.cidade).join(" e ")}: o extrato de compras quase não tem uso dessas cidades antes do ciclo atual. Envie o extrato do ciclo anterior para medir.
        </p>
      )}
      {d.extrato?.primeiro && d.extrato?.ultimo && (
        <p className="pd-note" style={{ margin: "0 0 10px" }}>
          Extrato de compras: {br(d.extrato.primeiro)} a {br(d.extrato.ultimo)}.
        </p>
      )}

      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Cidade</th>
              <th>Abre dia</th>
              <th>Base ativa</th>
              <th style={{ minWidth: 200 }}>Último ciclo completo</th>
              <th style={{ minWidth: 200 }}>Ciclo atual (parcial)</th>
            </tr>
          </thead>
          <tbody>
            {d.cidades.map((c) => (
              <tr key={c.cidade}>
                <td>{c.cidade}</td>
                <td>{c.diaAbertura}</td>
                <td>{int(c.base)}</td>
                <td>
                  {c.completo.semDados ? (
                    <span className="pd-hint" style={{ margin: 0 }}>sem dados ({br(c.completo.de)} a {br(c.completo.ate)})</span>
                  ) : (
                    <Barra m={c.completo} meta={d.meta} nota={`${br(c.completo.de)}–${br(c.completo.ate)} · ${c.completo.faltam > 0 ? `faltam ${int(c.completo.faltam)}` : "meta atingida"}`} />
                  )}
                </td>
                <td>
                  <Barra m={c.atual} meta={d.meta} nota={`dia ${c.atual.diaDoCiclo} · ${c.atual.faltam > 0 ? `faltam ${int(c.atual.faltam)}` : "meta atingida"}`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

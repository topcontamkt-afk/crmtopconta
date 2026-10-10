import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { FAIXA_LABELS } from "../utils/faixas";

interface Perfil {
  perfil: string;
  label: string;
  total: number;
  noTeto: number;
  faixas: Record<string, number>;
  etapas: Record<string, number>;
}
interface Resp {
  perfis: Perfil[];
  semLimite: number;
  extrato: { primeira: string | null; ultima: string | null };
}

const fmt = (n: number) => n.toLocaleString("pt-BR");

/** Perfis de renda PF1–PF4 estimados pelo limite (limite ÷ 0,40), com a quebra por faixa de uso. */
export default function PerfisRendaCard({ cidade, convenio }: { cidade: string; convenio: string }) {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const qs = new URLSearchParams();
    if (cidade) qs.set("cidade", cidade);
    if (convenio) qs.set("empresaConveniada", convenio);
    api<Resp>(`/dashboard/perfis-renda?${qs}`)
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e) => setError(e.message));
  }, [cidade, convenio]);

  if (error) return <div className="card pd-card error-text">Perfis de renda: {error}</div>;
  if (!data) return null;
  const total = data.perfis.reduce((a, p) => a + p.total, 0);

  return (
    <div className="card pd-card">
      <h3 style={{ marginTop: 0 }}>Perfis de renda (estimados pelo limite)</h3>
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 0 }}>
        Salário estimado = limite ÷ 0,40. O limite tem teto de R$ 2.000, então quem está no teto fica em PF2
        mesmo podendo ganhar mais. {fmt(data.semLimite)} clientes sem limite (comércio credenciado) ficam fora.
      </p>
      <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
        {data.extrato.ultima
          ? `Etapas de uso calculadas do extrato de compras de ${new Date(data.extrato.primeira!).toLocaleDateString("pt-BR")} a ${new Date(data.extrato.ultima).toLocaleDateString("pt-BR")}. Quem usou antes dessa data aparece como "nunca usou".`
          : "Nenhum extrato de compras importado ainda: as etapas de uso aparecem como \"nunca usou\" até o primeiro envio."}
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 12 }}>
        {data.perfis.map((p) => {
          const semUso = p.faixas["SEM_USO"] ?? 0;
          const cheio = p.faixas["USO_100"] ?? 0;
          return (
            <div key={p.perfil} style={{ border: "1px solid var(--border, #e5e7eb)", borderRadius: 8, padding: 12 }}>
              <strong>{p.label}</strong>
              <div style={{ fontSize: 26, fontWeight: 600 }}>{fmt(p.total)}</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                {total > 0 ? ((p.total / total) * 100).toFixed(1).replace(".", ",") : "0"}% da base
                {p.noTeto > 0 && ` · ${fmt(p.noTeto)} no teto de R$ 2.000`}
              </div>
              <div style={{ fontSize: 13, marginTop: 6 }}>
                {FAIXA_LABELS["SEM_USO"]}: <strong>{fmt(semUso)}</strong>
                <br />
                {FAIXA_LABELS["USO_100"]}: <strong>{fmt(cheio)}</strong>
                <hr style={{ margin: "6px 0", border: 0, borderTop: "1px solid var(--border, #e5e7eb)" }} />
                Recorrentes: <strong>{fmt(p.etapas["RECORRENTE"] ?? 0)}</strong> · Ocasionais: <strong>{fmt(p.etapas["OCASIONAL"] ?? 0)}</strong>
                <br />
                Em risco: <strong>{fmt(p.etapas["EM_RISCO"] ?? 0)}</strong> · Inativos: <strong>{fmt(p.etapas["INATIVO"] ?? 0)}</strong>
                <br />
                Nunca usaram: <strong>{fmt(p.etapas["NUNCA_USOU"] ?? 0)}</strong>
              </div>
            </div>
          );
        })}
      </div>
      <button className="btn secondary" style={{ marginTop: 10 }} onClick={() => navigate("/segments")}>
        Criar segmentos por perfil
      </button>
    </div>
  );
}

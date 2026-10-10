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
}
interface Resp {
  perfis: Perfil[];
  semLimite: number;
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

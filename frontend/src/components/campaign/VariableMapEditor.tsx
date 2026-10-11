import { useState } from "react";
import { api } from "../../api/client";
import { VARIAVEIS_NOSSAS, WaTemplate } from "./types";

/**
 * Template importado da Meta: o texto tem {{1}}, {{2}}... e a Meta não diz o que cada um significa.
 * Aqui a pessoa escolhe qual dado do cliente entra em cada posição (vale para todos os envios).
 */
export default function VariableMapEditor({ template, onSaved }: { template: WaTemplate; onSaved: (t: WaTemplate) => void }) {
  const positions = (template.metaBody?.match(/\{\{\s*\d+\s*\}\}/g) ?? []).map((m) => Number(m.replace(/\D/g, "")));
  const unique = [...new Set(positions)].sort((a, b) => a - b);
  const [map, setMap] = useState<(string | null)[]>(unique.map((_, i) => template.variableMap?.[i] ?? null));
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState("");
  if (!template.metaBody || unique.length === 0) return null;

  async function salvar() {
    setBusy(true);
    setErro("");
    try {
      const t = await api<WaTemplate>(`/templates/${template.id}`, { method: "PATCH", body: { variableMap: map } });
      onSaved(t);
    } catch (e: any) {
      setErro(e?.message || "Não foi possível salvar");
    } finally {
      setBusy(false);
    }
  }

  const mudou = JSON.stringify(map) !== JSON.stringify(unique.map((_, i) => template.variableMap?.[i] ?? null));
  const faltam = map.some((v) => !v);
  return (
    <div className="card" style={{ background: "var(--surface-alt)", marginTop: 12 }}>
      <strong style={{ fontSize: 13 }}>O que cada variável significa</strong>
      <p className="pd-hint" style={{ marginBottom: 8 }}>
        Este template veio da Meta com variáveis numeradas. Escolha qual dado do cliente entra em cada uma.
      </p>
      <div className="seg-row">
        {unique.map((n, i) => (
          <div className="form-row" key={n}>
            <label>{`{{${n}}}`}</label>
            <select value={map[i] ?? ""} onChange={(e) => setMap(map.map((v, j) => (j === i ? e.target.value || null : v)))}>
              <option value="">— escolha —</option>
              {VARIAVEIS_NOSSAS.map((v) => (
                <option key={v.key} value={v.key}>{v.label}</option>
              ))}
            </select>
          </div>
        ))}
      </div>
      {faltam && <p className="pd-hint" style={{ color: "var(--warning)" }}>Defina todas as variáveis para poder enviar.</p>}
      {erro && <p className="error-text">{erro}</p>}
      <button type="button" className="btn secondary" disabled={busy || !mudou} onClick={salvar}>Salvar variáveis</button>
    </div>
  );
}

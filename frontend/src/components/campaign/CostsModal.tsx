import { useEffect, useState } from "react";
import { api } from "../../api/client";

interface Cfg {
  marketingUsd: number | null;
  utilidadeUsd: number | null;
  cambioUsdBrl: number;
}

/** Valores usados na estimativa de custo (tabela da Meta, em dólar, por categoria + câmbio). */
export default function CostsModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [erro, setErro] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Cfg>("/campaigns/custos").then(setCfg).catch((e) => setErro(e?.message || "Erro ao carregar"));
  }, []);

  const num = (v: string): number | null => (v.trim() === "" ? null : Number(v.replace(",", ".")));

  async function salvar() {
    if (!cfg) return;
    setBusy(true);
    setErro("");
    try {
      await api("/campaigns/custos", { method: "PUT", body: cfg });
      onSaved();
      onClose();
    } catch (e: any) {
      setErro(e?.message?.includes("403") || e?.status === 403 ? "Só administradores podem alterar." : e?.message || "Erro ao salvar");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dsb-palette-overlay" onClick={onClose}>
      <div className="card" style={{ maxWidth: 440, width: "92%", margin: "10vh auto" }} onClick={(e) => e.stopPropagation()}>
        <h3>Custos por mensagem</h3>
        <p className="pd-hint" style={{ marginBottom: 10 }}>
          A Meta cobra por mensagem de template, conforme a categoria. Confira os valores atuais na tabela de preços da Meta; aqui é só a estimativa mostrada no assistente.
        </p>
        {cfg && (
          <>
            <div className="form-row">
              <label>Marketing (US$ por mensagem)</label>
              <input inputMode="decimal" value={cfg.marketingUsd ?? ""} onChange={(e) => setCfg({ ...cfg, marketingUsd: num(e.target.value) })} />
            </div>
            <div className="form-row">
              <label>Utilidade (US$ por mensagem)</label>
              <input inputMode="decimal" value={cfg.utilidadeUsd ?? ""} placeholder="não informado" onChange={(e) => setCfg({ ...cfg, utilidadeUsd: num(e.target.value) })} />
            </div>
            <div className="form-row">
              <label>Câmbio (R$ por US$)</label>
              <input inputMode="decimal" value={cfg.cambioUsdBrl} onChange={(e) => setCfg({ ...cfg, cambioUsdBrl: num(e.target.value) ?? 0 })} />
            </div>
          </>
        )}
        {erro && <p className="error-text">{erro}</p>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn secondary" onClick={onClose}>Cancelar</button>
          <button className="btn" disabled={busy || !cfg} onClick={salvar}>Salvar</button>
        </div>
      </div>
    </div>
  );
}

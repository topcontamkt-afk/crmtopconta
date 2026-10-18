import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { FAIXA_OPTIONS } from "../../utils/faixas";

export interface Filtros {
  cidade: string;
  faixaUso: string;
  etapaUso: string;
  statusConta: string;
  semUsoDiasMin: string;
  usadoNosUltimosDias: string;
  categoriaCompra: string;
  compraNosUltimosDias: string;
}

export const FILTROS_VAZIOS: Filtros = {
  cidade: "",
  faixaUso: "",
  etapaUso: "",
  statusConta: "",
  semUsoDiasMin: "",
  usadoNosUltimosDias: "",
  categoriaCompra: "",
  compraNosUltimosDias: "",
};

/** Filtros no formato que a API de campanhas aceita (só os preenchidos). */
export function filtrosParaApi(f: Filtros) {
  return {
    cidade: f.cidade ? [f.cidade] : undefined,
    faixaUso: f.faixaUso ? [f.faixaUso] : undefined,
    statusConta: f.statusConta ? [f.statusConta] : undefined,
    etapaUso: f.etapaUso ? [f.etapaUso] : undefined,
    semUsoDiasMin: f.semUsoDiasMin ? Number(f.semUsoDiasMin) : undefined,
    usadoNosUltimosDias: f.usadoNosUltimosDias ? Number(f.usadoNosUltimosDias) : undefined,
    categoriasCompra: f.categoriaCompra ? [f.categoriaCompra] : undefined,
    compraNosUltimosDias: f.compraNosUltimosDias ? Number(f.compraNosUltimosDias) : undefined,
  };
}

export default function FiltrosRapidos({ value, onChange }: { value: Filtros; onChange: (f: Filtros) => void }) {
  const [categorias, setCategorias] = useState<{ key: string; label: string }[]>([]);
  useEffect(() => {
    api<{ todasCategorias: { key: string; label: string }[] }>("/purchases/categories").then((r) => setCategorias(r.todasCategorias)).catch(() => {});
  }, []);
  const set = (k: keyof Filtros) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <input placeholder="Cidade" value={value.cidade} onChange={set("cidade")} />
      <select value={value.faixaUso} onChange={set("faixaUso")}>
        <option value="">Qualquer faixa de uso</option>
        {FAIXA_OPTIONS.map((f) => (
          <option key={f.value} value={f.value}>{f.label}</option>
        ))}
      </select>
      {/* LGPD 01-03: perfil de renda não é filtro de público (só estatística no Dashboard) */}
      <select value={value.etapaUso} onChange={set("etapaUso")}>
        <option value="">Qualquer etapa de uso</option>
        <option value="NUNCA_USOU">Nunca usou</option>
        <option value="RECORRENTE">Recorrente</option>
        <option value="OCASIONAL">Ocasional</option>
        <option value="EM_RISCO">Em risco (31–90 dias)</option>
        <option value="INATIVO">Inativo (+90 dias)</option>
      </select>
      <select value={value.statusConta} onChange={set("statusConta")}>
        <option value="">Qualquer status</option>
        <option value="ATIVO">Ativo</option>
        <option value="INATIVO">Inativo</option>
      </select>
      <input type="number" min={0} placeholder="Sem usar há (dias)" style={{ width: 150 }} value={value.semUsoDiasMin} onChange={set("semUsoDiasMin")} />
      <input type="number" min={0} placeholder="Usou nos últimos (dias)" style={{ width: 160 }} value={value.usadoNosUltimosDias} onChange={set("usadoNosUltimosDias")} />
      <select value={value.categoriaCompra} onChange={set("categoriaCompra")} aria-label="Comprou em (categoria de comércio)">
        <option value="">Qualquer comércio</option>
        {categorias.map((c) => (
          <option key={c.key} value={c.key}>Comprou em: {c.label}</option>
        ))}
      </select>
      <input type="number" min={0} placeholder="Comprou nos últimos (dias)" style={{ width: 170 }} value={value.compraNosUltimosDias} onChange={set("compraNosUltimosDias")} />
    </div>
  );
}

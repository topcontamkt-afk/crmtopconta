import { useEffect, useMemo, useState } from "react";
import { readSheet } from "read-excel-file/browser";
import { parseCsv } from "../../utils/csv";
import { PlanilhaRow } from "./types";

type Field = "nome" | "telefone" | "cpf" | "limiteDisponivel";

const FIELDS: { key: Field; label: string; required: boolean; hints: RegExp }[] = [
  { key: "nome", label: "Nome", required: true, hints: /nome|cliente|name/i },
  { key: "telefone", label: "Telefone / WhatsApp", required: true, hints: /telefone|celular|whats|contato|fone|phone/i },
  { key: "cpf", label: "CPF", required: false, hints: /cpf|cnpj|documento/i },
  { key: "limiteDisponivel", label: "Limite disponível", required: false, hints: /dispon|saldo|limite/i },
];

export const MAX_LINHAS = 5000;

async function readFileRows(file: File): Promise<string[][]> {
  if (/\.xlsx$/i.test(file.name)) {
    const data = await readSheet(file);
    return data.map((row) => row.map((c) => (c === null || c === undefined ? "" : c instanceof Date ? c.toISOString() : String(c))));
  }
  return parseCsv(await file.text());
}

/** Sobe a planilha (.xlsx ou .csv), escolhe as colunas e devolve as linhas já no formato do envio. */
export default function PlanilhaAudience({ onRows }: { onRows: (rows: PlanilhaRow[], fileName: string) => void }) {
  const [fileName, setFileName] = useState("");
  const [header, setHeader] = useState<string[]>([]);
  const [data, setData] = useState<string[][]>([]);
  const [map, setMap] = useState<Record<Field, string>>({ nome: "", telefone: "", cpf: "", limiteDisponivel: "" });
  const [erro, setErro] = useState("");

  const rows = useMemo<PlanilhaRow[]>(() => {
    const idx = (col: string) => (col ? header.indexOf(col) : -1);
    const i = { nome: idx(map.nome), telefone: idx(map.telefone), cpf: idx(map.cpf), limite: idx(map.limiteDisponivel) };
    if (i.nome < 0 || i.telefone < 0) return [];
    return data.map((r) => ({
      nome: r[i.nome] ?? "",
      telefone: r[i.telefone] ?? "",
      cpf: i.cpf >= 0 ? r[i.cpf] ?? "" : "",
      limiteDisponivel: i.limite >= 0 ? r[i.limite] ?? "" : "",
    }));
  }, [data, header, map]);

  useEffect(() => {
    onRows(rows, fileName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  async function onFile(file: File | undefined) {
    setErro("");
    if (!file) return;
    try {
      const all = (await readFileRows(file)).filter((r) => r.some((c) => String(c).trim() !== ""));
      if (all.length < 2) throw new Error("A planilha precisa ter o cabeçalho e ao menos uma linha");
      if (all.length - 1 > MAX_LINHAS) throw new Error(`A planilha tem ${all.length - 1} linhas; o máximo por campanha é ${MAX_LINHAS}. Divida em mais de uma.`);
      const head = all[0].map((h) => String(h).trim());
      setFileName(file.name);
      setHeader(head);
      setData(all.slice(1));
      const next: Record<Field, string> = { nome: "", telefone: "", cpf: "", limiteDisponivel: "" };
      const used = new Set<string>();
      for (const f of FIELDS) {
        const found = head.find((h) => h && !used.has(h) && f.hints.test(h));
        if (found) {
          next[f.key] = found;
          used.add(found);
        }
      }
      setMap(next);
    } catch (e: any) {
      setErro(e?.message || "Não consegui ler a planilha. Use .xlsx ou .csv");
    }
  }

  return (
    <div>
      <p className="pd-hint" style={{ marginBottom: 8 }}>
        Suba um arquivo .xlsx ou .csv com nome, telefone e, se quiser, CPF e limite disponível. O CPF liga o contato ao cliente da base (sem CPF, pelo telefone).
        O limite disponível só aparece na mensagem: não altera o cadastro do cliente.
      </p>
      <input type="file" accept=".xlsx,.csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} />
      {erro && <p className="error-text">{erro}</p>}
      {fileName && !erro && <p style={{ fontSize: 13 }}>{fileName}: {data.length} linhas</p>}

      {header.length > 0 && (
        <div className="seg-row" style={{ marginTop: 10 }}>
          {FIELDS.map((f) => (
            <div className="form-row" key={f.key}>
              <label>{f.label}{f.required ? " *" : ""}</label>
              <select value={map[f.key]} onChange={(e) => setMap({ ...map, [f.key]: e.target.value })}>
                <option value="">{f.required ? "— escolha a coluna —" : "— não tenho —"}</option>
                {header.map((h, i) => (h ? <option key={i} value={h}>{h}</option> : null))}
              </select>
            </div>
          ))}
        </div>
      )}
      {rows.length > 0 && (
        <p className="pd-hint">
          1ª linha: {rows[0].nome} · {rows[0].telefone}
          {rows[0].limiteDisponivel ? ` · limite ${rows[0].limiteDisponivel}` : ""}
        </p>
      )}
    </div>
  );
}

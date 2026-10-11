import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { readSheet } from "read-excel-file/browser";
import { api } from "../../api/client";
import { parseCsv } from "../../utils/csv";

interface Template {
  id: string;
  name: string;
  body: string;
  status: string;
  metaStatus?: string | null;
}

interface Preview {
  total: number;
  enviar: number;
  daBase: number;
  foraDaBase: number;
  recusadas: number;
  motivos: { linha: number; motivo: string }[];
}

type Field = "nome" | "telefone" | "cpf" | "limiteDisponivel";

const FIELDS: { key: Field; label: string; required: boolean; hints: RegExp }[] = [
  { key: "nome", label: "Nome", required: true, hints: /nome|cliente|name/i },
  { key: "telefone", label: "Telefone / WhatsApp", required: true, hints: /telefone|celular|whats|contato|fone|phone/i },
  { key: "cpf", label: "CPF", required: false, hints: /cpf|cnpj|documento/i },
  { key: "limiteDisponivel", label: "Limite disponível", required: false, hints: /dispon|saldo|limite/i },
];

const SAMPLE = { nome: "Maria", cidade: "Natal", percentual: "45", saldo: "R$ 850,00", limite: "R$ 1.500,00", limite_disponivel: "R$ 850,00" };

function renderPreview(body: string) {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, v) => (SAMPLE as Record<string, string>)[v] ?? "");
}

async function readFileRows(file: File): Promise<string[][]> {
  if (/\.xlsx$/i.test(file.name)) {
    const data = await readSheet(file);
    return data.map((row) => row.map((c) => (c === null || c === undefined ? "" : c instanceof Date ? c.toISOString() : String(c))));
  }
  return parseCsv(await file.text());
}

export default function ManualCampaign() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [fileName, setFileName] = useState("");
  const [header, setHeader] = useState<string[]>([]);
  const [data, setData] = useState<string[][]>([]);
  const [map, setMap] = useState<Record<Field, string>>({ nome: "", telefone: "", cpf: "", limiteDisponivel: "" });
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ id: string; enviar: number } | null>(null);
  const [dispatchMsg, setDispatchMsg] = useState("");

  useEffect(() => {
    // Atualiza o status dos templates com a Meta antes de listar (se a conta estiver conectada).
    api("/templates/sync", { method: "POST" })
      .catch(() => undefined)
      .finally(() => api<Template[]>("/templates?channel=WHATSAPP&status=APROVADO").then(setTemplates));
  }, []);

  const template = templates.find((t) => t.id === templateId);
  const usesLimite = !!template && /\{\{\s*(saldo|limite_disponivel)\s*\}\}/.test(template.body);

  const rows = useMemo(() => {
    const idx = (col: string) => (col ? header.indexOf(col) : -1);
    const i = { nome: idx(map.nome), telefone: idx(map.telefone), cpf: idx(map.cpf), limite: idx(map.limiteDisponivel) };
    return data.map((r) => ({
      nome: i.nome >= 0 ? r[i.nome] : "",
      telefone: i.telefone >= 0 ? r[i.telefone] : "",
      cpf: i.cpf >= 0 ? r[i.cpf] : "",
      limiteDisponivel: i.limite >= 0 ? r[i.limite] : "",
    }));
  }, [data, header, map]);

  async function onFile(file: File | undefined) {
    setError("");
    setPreview(null);
    if (!file) return;
    try {
      const all = (await readFileRows(file)).filter((r) => r.some((c) => String(c).trim() !== ""));
      if (all.length < 2) throw new Error("A planilha precisa ter o cabeçalho e ao menos uma linha");
      const head = all[0].map((h) => String(h).trim());
      setFileName(file.name);
      setHeader(head);
      setData(all.slice(1));
      // sugere as colunas pelo nome do cabeçalho
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
      if (!name) setName(`Campanha manual ${new Date().toLocaleDateString("pt-BR")}`);
    } catch (e: any) {
      setError(e?.message || "Não consegui ler a planilha. Use .xlsx ou .csv");
    }
  }

  const mapOk = !!map.nome && !!map.telefone;
  const ready = mapOk && !!templateId && data.length > 0;

  async function conferir() {
    setBusy(true);
    setError("");
    try {
      setPreview(await api<Preview>("/campaigns/manual/preview", { method: "POST", body: { templateId, rows } }));
    } catch (e: any) {
      setError(e?.message || "Erro ao conferir a lista");
    } finally {
      setBusy(false);
    }
  }

  async function criar() {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ campaign: { id: string }; enviar: number }>("/campaigns/manual", {
        method: "POST",
        body: { name, templateId, rows, consentimento: true },
      });
      setCreated({ id: r.campaign.id, enviar: r.enviar });
    } catch (e: any) {
      setError(e?.message || "Erro ao criar a campanha");
    } finally {
      setBusy(false);
    }
  }

  async function dispararLote() {
    if (!created) return;
    setBusy(true);
    try {
      const r = await api<{ processed: number; remaining: number; bloqueado?: string; throttled?: boolean }>(`/campaigns/${created.id}/dispatch`, {
        method: "POST",
        body: { limit: 50 },
      });
      setDispatchMsg(r.bloqueado ? r.bloqueado : r.throttled ? "Limite de envios por minuto atingido, tente novamente em instantes." : `${r.processed} processados, ${r.remaining} na fila.`);
    } catch (e: any) {
      setDispatchMsg(e?.message || "Erro ao disparar");
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div>
        <div className="topbar"><h2>Campanha manual criada</h2></div>
        <div className="card">
          <p><strong>{created.enviar}</strong> contatos na fila de envio. Os envios aparecem no Inbox e o resultado (uso do limite e dias até o uso) no relatório da campanha.</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn" disabled={busy} onClick={dispararLote}>Disparar lote (50)</button>
            <Link className="btn secondary" to={`/campaigns/${created.id}/report`}>Ver relatório</Link>
            <Link className="btn secondary" to="/campaigns">Campanhas</Link>
          </div>
          {dispatchMsg && <p style={{ marginTop: 12 }}>{dispatchMsg}</p>}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="topbar">
        <h2>Campanha manual (planilha)</h2>
        <Link className="btn secondary" to="/campaigns">Voltar</Link>
      </div>

      <div className="card">
        <h3>1. Planilha</h3>
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
          Suba um arquivo .xlsx ou .csv com nome, telefone e, se quiser, CPF e limite disponível. O CPF liga o contato ao cliente da base
          (sem CPF, o vínculo é feito pelo telefone). O limite disponível só aparece na mensagem: não altera o cadastro do cliente.
        </p>
        <input type="file" accept=".xlsx,.csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} />
        {fileName && <p style={{ fontSize: 13 }}>{fileName}: {data.length} linhas</p>}

        {header.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginTop: 12 }}>
            {FIELDS.map((f) => (
              <div className="form-row" key={f.key}>
                <label>{f.label}{f.required ? " *" : ""}</label>
                <select value={map[f.key]} onChange={(e) => { setMap({ ...map, [f.key]: e.target.value }); setPreview(null); }}>
                  <option value="">{f.required ? "— escolha a coluna —" : "— não tenho —"}</option>
                  {header.map((h, i) => (h ? <option key={i} value={h}>{h}</option> : null))}
                </select>
              </div>
            ))}
          </div>
        )}
        {rows.length > 0 && mapOk && (
          <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
            Exemplo da 1ª linha: {rows[0].nome} · {rows[0].telefone}{rows[0].limiteDisponivel ? ` · limite ${rows[0].limiteDisponivel}` : ""}
          </p>
        )}
      </div>

      <div className="card">
        <h3>2. Template aprovado pela Meta</h3>
        <div className="form-row">
          <select value={templateId} onChange={(e) => { setTemplateId(e.target.value); setPreview(null); }}>
            <option value="">— escolha o template —</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}{t.metaStatus && t.metaStatus !== "APPROVED" ? ` (Meta: ${t.metaStatus})` : ""}
              </option>
            ))}
          </select>
        </div>
        {templates.length === 0 && (
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Nenhum template aprovado ainda. Crie e envie um template para a Meta em "Templates".</p>
        )}
        {template && (
          <p style={{ background: "var(--surface-2, #f4f4f5)", padding: 12, borderRadius: 8, whiteSpace: "pre-wrap" }}>{renderPreview(template.body)}</p>
        )}
        {usesLimite && !map.limiteDisponivel && (
          <p style={{ color: "#b45309", fontSize: 13 }}>
            Este template usa o limite disponível, mas nenhuma coluna de limite foi escolhida: nenhum contato poderá receber.
          </p>
        )}
      </div>

      <div className="card">
        <h3>3. Conferir e criar</h3>
        <div className="form-row">
          <label>Nome da campanha</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <button className="btn secondary" disabled={!ready || busy} onClick={conferir}>Conferir lista</button>

        {preview && (
          <div style={{ marginTop: 12 }}>
            <p>
              <strong>{preview.enviar}</strong> de {preview.total} contatos vão receber
              {" "}({preview.daBase} são clientes da base e serão medidos pelo uso real; {preview.foraDaBase} fora da base ficam guardados para análise).
            </p>
            {preview.recusadas > 0 && (
              <details>
                <summary>{preview.recusadas} linhas recusadas</summary>
                <ul style={{ fontSize: 13 }}>
                  {preview.motivos.map((m, i) => <li key={i}>Linha {m.linha + 1}: {m.motivo}</li>)}
                  {preview.recusadas > preview.motivos.length && <li>… e mais {preview.recusadas - preview.motivos.length}</li>}
                </ul>
              </details>
            )}
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", margin: "12px 0" }}>
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 3 }} />
              <span style={{ fontSize: 13 }}>
                Confirmo que tenho autorização para contatar estes números pelo WhatsApp. Quem já pediu para não receber mensagens foi retirado da lista automaticamente.
              </span>
            </label>
            <button className="btn" disabled={busy || !consent || preview.enviar === 0 || !name.trim()} onClick={criar}>
              Criar campanha com {preview.enviar} contatos
            </button>
          </div>
        )}
        {error && <p style={{ color: "#b91c1c" }}>{error}</p>}
      </div>
    </div>
  );
}

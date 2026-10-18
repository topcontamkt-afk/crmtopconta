import { ChangeEvent, Fragment, useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { parseCsv } from "../utils/csv";
import { autoMapColumns, CARD_ACCOUNT_FIELDS, IMPORT_FIELDS, ImportFieldDef, PURCHASE_FIELDS } from "../utils/importFields";
import { detectFormat, FORMAT_LABEL, hasValue } from "../utils/importFormat";

type UploadFormat = "cartoes" | "generico" | "compras";

const FORMAT_CONFIG: Record<UploadFormat, { label: string; fields: ImportFieldDef[]; endpoint: string }> = {
  cartoes: { label: "Cartões e contas (cadastro/ativação de cartão)", fields: CARD_ACCOUNT_FIELDS, endpoint: "/imports/cartoes" },
  generico: { label: "Genérico (id_cliente, status_conta, autorização LGPD...)", fields: IMPORT_FIELDS, endpoint: "/imports/csv" },
  compras: { label: "Compras (aba “Todas as Compras”: transações do cartão e lojistas)", fields: PURCHASE_FIELDS, endpoint: "/purchases/import" },
};

interface Quality {
  totalClientes: number;
  registrosIncompletos: { semCidade: number; semDataCadastro: number; semDataAberturaConta: number };
  importacoesUltimos30Dias: number;
  importacoesComErro: number;
  motivosDeErroMaisComuns: { motivo: string; count: number }[];
}

interface Lote {
  loteId: string;
  formato: string | null;
  formatoNome: string | null;
  nomeArquivo: string | null;
  source: string;
  status: string;
  startedAt: string;
  totalRows: number;
  addedCount: number;
  updatedCount: number;
  errorCount: number;
  desfeita: boolean;
  podeDesfazer: boolean;
}

interface Preview {
  total: number;
  invalidos: number;
  novos: number;
  atualizados: number;
  semAlteracao: number;
  limite: { alterados: number; zerados: number; aumentaram: number; diminuiram: number };
  saldoAlterados: number;
  status: { alterados: number; paraInativo: number; paraBloqueado: number; paraAtivo: number };
  autorizacao: { revogadas: number; concedidas: number };
  cadastroAlterados: number;
  ignorados: string[];
  exemplosZerados: { nome: string; limiteAntes: number }[];
}

/** Acima disto, zerar limites exige uma confirmação a mais (20 clientes ou 2% dos atualizados). */
function muitosZerados(p: Preview): boolean {
  return p.limite.zerados >= 20 || (p.atualizados > 0 && p.limite.zerados / p.atualizados >= 0.02);
}

function sumPreview(a: Preview, b: Preview): Preview {
  return {
    total: a.total + b.total,
    invalidos: a.invalidos + b.invalidos,
    novos: a.novos + b.novos,
    atualizados: a.atualizados + b.atualizados,
    semAlteracao: a.semAlteracao + b.semAlteracao,
    limite: {
      alterados: a.limite.alterados + b.limite.alterados,
      zerados: a.limite.zerados + b.limite.zerados,
      aumentaram: a.limite.aumentaram + b.limite.aumentaram,
      diminuiram: a.limite.diminuiram + b.limite.diminuiram,
    },
    saldoAlterados: a.saldoAlterados + b.saldoAlterados,
    status: {
      alterados: a.status.alterados + b.status.alterados,
      paraInativo: a.status.paraInativo + b.status.paraInativo,
      paraBloqueado: a.status.paraBloqueado + b.status.paraBloqueado,
      paraAtivo: a.status.paraAtivo + b.status.paraAtivo,
    },
    autorizacao: { revogadas: a.autorizacao.revogadas + b.autorizacao.revogadas, concedidas: a.autorizacao.concedidas + b.autorizacao.concedidas },
    cadastroAlterados: a.cadastroAlterados + b.cadastroAlterados,
    ignorados: [...new Set([...a.ignorados, ...b.ignorados])],
    exemplosZerados: [...a.exemplosZerados, ...b.exemplosZerados].slice(0, 5),
  };
}

const EMPTY: Preview = {
  total: 0, invalidos: 0, novos: 0, atualizados: 0, semAlteracao: 0,
  limite: { alterados: 0, zerados: 0, aumentaram: 0, diminuiram: 0 }, saldoAlterados: 0,
  status: { alterados: 0, paraInativo: 0, paraBloqueado: 0, paraAtivo: 0 }, autorizacao: { revogadas: 0, concedidas: 0 },
  cadastroAlterados: 0, ignorados: [], exemplosZerados: [],
};

const fmtBRL = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export default function Imports() {
  const [quality, setQuality] = useState<Quality | null>(null);
  const [lotes, setLotes] = useState<Lote[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loteErrors, setLoteErrors] = useState<Record<string, { row: number; motivo: string }[]>>({});
  const [undoing, setUndoing] = useState<string | null>(null);
  const [undoMsg, setUndoMsg] = useState<string | null>(null);

  const { user } = useAuth();
  const [purgeText, setPurgeText] = useState("");
  const [purgeMsg, setPurgeMsg] = useState<string | null>(null);

  async function handlePurge() {
    setPurgeMsg(null);
    try {
      const r = await api<{ clients: number; supressoesGravadas?: number }>("/clients/purge", { method: "POST", body: { confirm: purgeText } });
      setPurgeMsg(
        `Base limpa: ${r.clients} clientes removidos. Já pode importar a planilha correta.` +
          (r.supressoesGravadas ? ` ${r.supressoesGravadas} pedido(s) de opt-out/bloqueio guardado(s) para valer na reimportação.` : "")
      );
      setPurgeText("");
      load();
    } catch (err: any) {
      setPurgeMsg(err?.message || "Falha ao limpar a base");
    }
  }

  const [format, setFormat] = useState<UploadFormat>("cartoes");
  const [fileName, setFileName] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [dataRows, setDataRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [importing, setImporting] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirmZerar, setConfirmZerar] = useState(false);
  const [forcarFormato, setForcarFormato] = useState(false);

  const activeFields = FORMAT_CONFIG[format].fields;

  function load() {
    api<Quality>("/imports/quality").then(setQuality);
    api<Lote[]>("/imports/lotes").then(setLotes);
  }
  useEffect(load, []);

  function changeFormat(next: UploadFormat) {
    setFormat(next);
    resetUpload();
  }

  // Troca o formato mantendo o arquivo já lido (usado pelo aviso de formato errado)
  function useDetectedFormat(next: UploadFormat) {
    setFormat(next);
    setMapping(autoMapColumns(headers, FORMAT_CONFIG[next].fields));
    setPreview(null);
    setConfirmZerar(false);
    setForcarFormato(false);
  }

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadStatus(null);
    setUploadError(null);
    try {
      const text = await file.text();
      const rows = parseCsv(text);
      if (rows.length < 2) {
        setUploadError("O arquivo precisa ter uma linha de cabeçalho e ao menos uma linha de dados.");
        return;
      }
      const [header, ...body] = rows;
      setFileName(file.name);
      setHeaders(header);
      setDataRows(body);
      setMapping(autoMapColumns(header, activeFields));
    } catch {
      setUploadError("Não consegui ler esse arquivo. Confirme que é um .csv válido.");
    } finally {
      e.target.value = ""; // permite selecionar o mesmo arquivo de novo depois de corrigir algo
    }
  }

  function resetUpload() {
    setFileName(null);
    setHeaders([]);
    setDataRows([]);
    setMapping({});
    setUploadStatus(null);
    setUploadError(null);
    setPreview(null);
    setConfirmZerar(false);
    setForcarFormato(false);
  }

  const detected = headers.length > 0 ? detectFormat(headers) : "desconhecido";
  const formatWrong = detected !== "desconhecido" && detected !== format;
  const isAdmin = user?.role === "ADMIN";
  const blocked = formatWrong && !(forcarFormato && isAdmin);

  // O que o ARQUIVO INTEIRO traz (não só o lote): coluna presente = ao menos uma célula com valor.
  const presence = {
    limite: hasValue(dataRows, mapping.limite),
    saldo: hasValue(dataRows, mapping.saldo_disponivel),
    utilizado: hasValue(dataRows, mapping.valor_utilizado),
    status: ["status_cartao", "status_cadastro", "bloqueado", "cartao_bloqueado", "conta_bloqueada", "encerrado"].some((k) => hasValue(dataRows, mapping[k])),
  };
  const semColunasSensiveis = format === "cartoes" && !presence.limite && !presence.saldo && !presence.status;

  const requiredMissing = activeFields.filter((f) => f.required && mapping[f.key] === undefined);

  // Ainda envia em lotes (não tudo numa requisição só) por segurança — mesmo com a importação
  // no back-end agora gravando em paralelo e em lote (bem mais rápida), uma única requisição
  // gigante continua arriscando estourar o tempo máximo de execução da função serverless. O
  // valor subiu de 150 pra 400 porque cada linha ficou bem mais barata de processar.
  const BATCH_SIZE = 400;

  function buildRows() {
    return dataRows.map((row) => {
      const obj: Record<string, string> = {};
      for (const field of activeFields) {
        const idx = mapping[field.key];
        if (idx !== undefined) obj[field.key] = (row[idx] ?? "").trim();
      }
      return obj;
    });
  }

  // Campos genéricos que o arquivo inteiro traz (protege limite/saldo/status quando a coluna não existe)
  function camposPresentesGenerico(): string[] {
    return ["limite_total", "valor_utilizado", "saldo_disponivel", "valor_antecipado", "status_conta", "autorizacao_comunicacao"].filter((k) => hasValue(dataRows, mapping[k]));
  }

  function extraBody() {
    return {
      cabecalhos: headers,
      nomeArquivo: fileName ?? undefined,
      ...(forcarFormato && isAdmin ? { forcarFormato: true } : {}),
    };
  }

  // Passo "Conferir impacto" (só Cartões e contas): simula o arquivo inteiro sem gravar nada
  async function handlePreview() {
    setPreviewing(true);
    setUploadStatus(null);
    setUploadError(null);
    setConfirmZerar(false);
    try {
      const rows = buildRows();
      const batches = Math.ceil(rows.length / BATCH_SIZE) || 1;
      let total = EMPTY;
      for (let i = 0; i < batches; i++) {
        setUploadStatus(`Conferindo lote ${i + 1} de ${batches}...`);
        const r = await api<Preview>("/imports/cartoes/preview", {
          method: "POST",
          body: { rows: rows.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE), camposPresentes: presence, ...extraBody() },
        });
        total = sumPreview(total, r);
      }
      setPreview(total);
      setUploadStatus(null);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Não consegui conferir o impacto");
      setUploadStatus(null);
    } finally {
      setPreviewing(false);
    }
  }

  async function handleImport() {
    setImporting(true);
    setUploadStatus(null);
    setUploadError(null);

    const rows = buildRows();
    const loteId = crypto.randomUUID(); // todos os lotes do arquivo compartilham: vira UMA linha no histórico
    const protecao: Record<string, unknown> =
      format === "cartoes" ? { camposPresentes: presence } : format === "generico" ? { camposPresentes: camposPresentesGenerico() } : {};

    const totalBatches = Math.ceil(rows.length / BATCH_SIZE) || 1;
    let added = 0;
    let updated = 0;
    let errors = 0;
    let unmatched = 0;
    let merchantsCreated = 0;
    // LGPD 03-01 / 03-03 / 03-04: o que a importação deixou de fora ou preservou de propósito
    const lgpd = { eliminadosAPedido: 0, bloqueadosLgpd: 0, supressoesLiberadas: 0, camposPreservadosCorrecao: 0 };

    try {
      for (let i = 0; i < totalBatches; i++) {
        const batch = rows.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
        setUploadStatus(`Importando lote ${i + 1} de ${totalBatches} (${added + updated} de ${rows.length} processados até agora)...`);
        const resp = await api<{
          addedCount: number;
          updatedCount: number;
          errorCount: number;
          unmatchedRows?: number;
          merchantsCreated?: number;
          eliminadosAPedido?: number;
          bloqueadosLgpd?: number;
          supressoesLiberadas?: number;
          camposPreservadosCorrecao?: number;
        }>(
          FORMAT_CONFIG[format].endpoint,
          { method: "POST", body: { rows: batch, loteId, ...protecao, ...extraBody() } }
        );
        added += resp.addedCount;
        updated += resp.updatedCount;
        errors += resp.errorCount;
        unmatched += resp.unmatchedRows ?? 0;
        merchantsCreated += resp.merchantsCreated ?? 0;
        lgpd.eliminadosAPedido += resp.eliminadosAPedido ?? 0;
        lgpd.bloqueadosLgpd += resp.bloqueadosLgpd ?? 0;
        lgpd.supressoesLiberadas += resp.supressoesLiberadas ?? 0;
        lgpd.camposPreservadosCorrecao += resp.camposPreservadosCorrecao ?? 0;
      }
      const avisosLgpd = [
        lgpd.eliminadosAPedido > 0 ? `${lgpd.eliminadosAPedido} linha(s) ignorada(s): titular pediu a eliminação dos dados` : "",
        lgpd.bloqueadosLgpd > 0 ? `${lgpd.bloqueadosLgpd} linha(s) ignorada(s): tratamento bloqueado a pedido do titular` : "",
        lgpd.supressoesLiberadas > 0 ? `${lgpd.supressoesLiberadas} titular(es) voltou(aram) por conta aberta depois do pedido de eliminação` : "",
        lgpd.camposPreservadosCorrecao > 0 ? `${lgpd.camposPreservadosCorrecao} campo(s) corrigido(s) à mão mantido(s) (a planilha não sobrescreve correção)` : "",
      ].filter(Boolean);
      setUploadStatus(
        format === "compras"
          ? `Compras importadas: ${added} novas, ${updated} já existiam, ${merchantsCreated} lojista(s) novo(s), ${errors} linha(s) com erro.` +
              (unmatched > 0
                ? ` ${unmatched} transação(ões) ficaram de fora porque o cliente ainda não está na base: importe os clientes e envie este arquivo de novo (não duplica).`
                : "")
          : `Importado: ${added} novos, ${updated} atualizados, ${errors} com erro/aviso.` +
              (errors > 0 ? " Veja o detalhe no histórico abaixo." : "") +
              (avisosLgpd.length ? ` LGPD: ${avisosLgpd.join("; ")}.` : "")
      );
      resetUpload();
      load();
    } catch (e) {
      setUploadStatus(
        `Parou no meio do caminho: ${added} novos, ${updated} atualizados, ${errors} com erro/aviso até aqui. ` +
          "As linhas já processadas ficam salvas — corrija o problema e importe de novo (linhas já existentes só atualizam, não duplicam)."
      );
      setUploadError(e instanceof Error ? e.message : "Erro ao importar planilha");
      load();
    } finally {
      setImporting(false);
    }
  }

  async function toggleErrors(loteId: string) {
    if (expanded === loteId) return setExpanded(null);
    setExpanded(loteId);
    if (!loteErrors[loteId]) {
      try {
        const r = await api<{ errors: { row: number; motivo: string }[] }>(`/imports/lotes/${loteId}`);
        setLoteErrors((m) => ({ ...m, [loteId]: r.errors }));
      } catch {
        setLoteErrors((m) => ({ ...m, [loteId]: [] }));
      }
    }
  }

  // Desfaz em partes (a função serverless tem tempo limitado): repete até o servidor dizer que acabou
  async function handleUndo(l: Lote) {
    const nome = l.nomeArquivo ?? "esta importação";
    if (!window.confirm(`Desfazer a importação de “${nome}”?\n\nOs clientes voltam ao estado de antes (os criados por ela serão removidos). Alterações feitas depois nesses clientes serão perdidas.`)) return;
    setUndoing(l.loteId);
    setUndoMsg(null);
    let restaurados = 0, removidos = 0, mantidos = 0, protegidos = 0;
    try {
      for (let guard = 0; guard < 500; guard++) {
        const r = await api<{ restaurados: number; removidos: number; mantidos: number; protegidos?: number; restantes: number; concluido: boolean }>(`/imports/lotes/${l.loteId}/desfazer`, { method: "POST" });
        restaurados += r.restaurados; removidos += r.removidos; mantidos += r.mantidos; protegidos += r.protegidos ?? 0;
        setUndoMsg(`Desfazendo... ${restaurados + removidos + mantidos} cliente(s) processado(s), faltam ${r.restantes}.`);
        if (r.concluido) break;
      }
      setUndoMsg(
        `Importação desfeita: ${restaurados} cliente(s) restaurado(s), ${removidos} removido(s)` +
          (mantidos > 0 ? `, ${mantidos} mantido(s) por terem mudado depois` : "") +
          // LGPD 04-04: desfazer nunca devolve os dados de quem foi anonimizado, bloqueado ou pediu eliminação
          (protegidos > 0 ? `, ${protegidos} não restaurado(s) por pedido LGPD do titular` : "") +
          "."
      );
    } catch (e) {
      setUndoMsg(e instanceof Error ? e.message : "Não consegui desfazer");
    } finally {
      setUndoing(null);
      load();
    }
  }

  return (
    <div>
      <h2>Importações &amp; Qualidade da base</h2>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3>Upload de planilha (.csv)</h3>
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
          Exporte sua planilha de clientes como CSV (Excel/Google Sheets: Arquivo → Salvar como/Fazer
          download → CSV) e selecione o arquivo abaixo. Campos com * são obrigatórios; o resto é
          opcional. Se preferir manter a planilha sempre no Google Sheets com sincronização
          automática, use a tela <strong>Integrações</strong> em vez deste upload.
        </p>
        <div className="form-row">
          <label>Formato da planilha</label>
          <select value={format} onChange={(e) => changeFormat(e.target.value as UploadFormat)}>
            {(Object.keys(FORMAT_CONFIG) as UploadFormat[]).map((key) => (
              <option key={key} value={key}>{FORMAT_CONFIG[key].label}</option>
            ))}
          </select>
        </div>
        <input type="file" accept=".csv,text/csv" onChange={handleFile} />
        {uploadError && <p className="error-text" style={{ marginTop: 8 }}>{uploadError}</p>}
        {uploadStatus && <p style={{ marginTop: 8 }}>{uploadStatus}</p>}

        {fileName && (
          <div style={{ marginTop: 16 }}>
            <p style={{ fontSize: 13 }}>
              <strong>{fileName}</strong> — {dataRows.length} linha(s) detectada(s). Confira o
              mapeamento de colunas (ajustei automaticamente o que reconheci pelo cabeçalho):
            </p>
            <table>
              <thead>
                <tr><th>Campo do sistema</th><th>Coluna da planilha</th></tr>
              </thead>
              <tbody>
                {activeFields.map((field) => (
                  <tr key={field.key}>
                    <td>{field.label}{field.required && " *"}</td>
                    <td>
                      <select
                        value={mapping[field.key] ?? ""}
                        onChange={(e) =>
                          setMapping((m) => {
                            const next = { ...m };
                            if (e.target.value === "") delete next[field.key];
                            else next[field.key] = Number(e.target.value);
                            return next;
                          })
                        }
                      >
                        <option value="">— não usar —</option>
                        {headers.map((h, i) => (
                          <option key={i} value={i}>{h || `Coluna ${i + 1}`}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {dataRows.length > 0 && (
              <div style={{ marginTop: 10, overflowX: "auto" }}>
                <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>Prévia (3 primeiras linhas):</p>
                <table>
                  <thead>
                    <tr>{headers.map((h, i) => <th key={i}>{h || `Coluna ${i + 1}`}</th>)}</tr>
                  </thead>
                  <tbody>
                    {dataRows.slice(0, 3).map((row, i) => (
                      <tr key={i}>{headers.map((_, j) => <td key={j}>{row[j]}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {formatWrong && (
              <div className="card" style={{ marginTop: 10, borderColor: "var(--danger, #d9534f)" }}>
                <p style={{ margin: 0 }}>
                  <strong>Este arquivo parece ser do formato “{FORMAT_LABEL[detected as keyof typeof FORMAT_LABEL]}”</strong>, mas o formato escolhido é
                  “{FORMAT_LABEL[format]}”. Importar assim pode gravar dados errados nos clientes.
                </p>
                <div style={{ marginTop: 8 }}>
                  <button className="btn" onClick={() => useDetectedFormat(detected as UploadFormat)}>
                    Usar o formato {FORMAT_LABEL[detected as keyof typeof FORMAT_LABEL]}
                  </button>
                  {isAdmin && (
                    <label style={{ marginLeft: 12, fontSize: 13 }}>
                      <input type="checkbox" checked={forcarFormato} onChange={(e) => setForcarFormato(e.target.checked)} /> Sei o que estou fazendo, importar assim mesmo
                    </label>
                  )}
                </div>
              </div>
            )}

            {!formatWrong && semColunasSensiveis && (
              <p style={{ marginTop: 10, fontSize: 13, color: "var(--warning, #b8860b)" }}>
                Este arquivo não traz limite, saldo nem status. Para os clientes que já existem, esses dados <strong>serão mantidos como estão</strong>
                (só cadastro e demais campos são atualizados).
              </p>
            )}

            {requiredMissing.length > 0 && (
              <p className="error-text" style={{ marginTop: 10 }}>
                Mapeie as colunas obrigatórias: {requiredMissing.map((f) => f.label).join(", ")}.
              </p>
            )}

            {preview && (
              <div className="card" style={{ marginTop: 12 }}>
                <h4 style={{ marginTop: 0 }}>Conferir impacto (nada foi gravado ainda)</h4>
                <ul style={{ fontSize: 13, lineHeight: 1.7 }}>
                  <li><strong>{preview.novos}</strong> cliente(s) novo(s) e <strong>{preview.atualizados}</strong> existente(s) atualizado(s) ({preview.semAlteracao} sem nenhuma mudança){preview.invalidos > 0 && <>; <strong>{preview.invalidos}</strong> linha(s) inválida(s) ficam de fora</>}.</li>
                  <li>
                    Limite: <strong>{preview.limite.alterados}</strong> alterado(s) ({preview.limite.aumentaram} sobem, {preview.limite.diminuiram} descem,{" "}
                    <strong style={{ color: preview.limite.zerados > 0 ? "var(--danger, #d9534f)" : undefined }}>{preview.limite.zerados} ficam zerados</strong>).
                  </li>
                  <li>Saldo disponível alterado em <strong>{preview.saldoAlterados}</strong> cliente(s).</li>
                  <li>
                    Status alterado em <strong>{preview.status.alterados}</strong> ({preview.status.paraInativo} inativos, {preview.status.paraBloqueado} bloqueados, {preview.status.paraAtivo} ativos).
                  </li>
                  <li>
                    Autorização de comunicação: <strong style={{ color: preview.autorizacao.revogadas > 0 ? "var(--danger, #d9534f)" : undefined }}>{preview.autorizacao.revogadas} revogada(s)</strong>, {preview.autorizacao.concedidas} concedida(s).
                  </li>
                  {preview.ignorados.length > 0 && (
                    <li>O arquivo não traz <strong>{preview.ignorados.join(", ")}</strong>: isso <strong>não será alterado</strong> nos clientes existentes.</li>
                  )}
                </ul>
                {preview.exemplosZerados.length > 0 && (
                  <p style={{ fontSize: 13 }}>
                    Exemplos de quem perde o limite: {preview.exemplosZerados.map((e) => `${e.nome} (era ${fmtBRL(e.limiteAntes)})`).join("; ")}.
                  </p>
                )}
                {muitosZerados(preview) && (
                  <label style={{ fontSize: 13, color: "var(--danger, #d9534f)" }}>
                    <input type="checkbox" checked={confirmZerar} onChange={(e) => setConfirmZerar(e.target.checked)} /> Conferi: {preview.limite.zerados} clientes
                    vão ficar com limite zero e é isso mesmo que quero.
                  </label>
                )}
                <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 0 }}>
                  Depois de importar, o botão “Desfazer” aparece no histórico (só para o administrador e só na última importação de clientes).
                </p>
              </div>
            )}

            <div style={{ marginTop: 12 }}>
              {format === "cartoes" && !preview ? (
                <button className="btn" disabled={previewing || importing || requiredMissing.length > 0 || blocked} onClick={handlePreview}>
                  {previewing ? "Conferindo..." : "Conferir impacto"}
                </button>
              ) : (
                <button
                  className="btn"
                  disabled={importing || requiredMissing.length > 0 || blocked || (preview !== null && muitosZerados(preview) && !confirmZerar)}
                  onClick={handleImport}
                >
                  {importing ? "Importando..." : `Importar ${dataRows.length} linhas`}
                </button>
              )}{" "}
              <button className="btn secondary" onClick={resetUpload} disabled={importing || previewing}>Cancelar</button>
            </div>
          </div>
        )}
      </div>

      {quality && (
        <div className="grid-kpi">
          <div className="card"><div className="kpi-value">{quality.totalClientes}</div><div className="kpi-label">Total de clientes</div></div>
          <div className="card"><div className="kpi-value">{quality.registrosIncompletos.semCidade}</div><div className="kpi-label">Sem cidade</div></div>
          <div className="card"><div className="kpi-value">{quality.registrosIncompletos.semDataCadastro}</div><div className="kpi-label">Sem data de cadastro</div></div>
          <div className="card"><div className="kpi-value">{quality.importacoesComErro}</div><div className="kpi-label">Importações c/ erro (30d)</div></div>
        </div>
      )}

      {quality && quality.motivosDeErroMaisComuns.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3>Motivos de erro mais comuns (últimos 30 dias)</h3>
          <table>
            <thead><tr><th>Motivo</th><th>Ocorrências</th></tr></thead>
            <tbody>
              {quality.motivosDeErroMaisComuns.map((m) => (
                <tr key={m.motivo}><td>{m.motivo}</td><td>{m.count}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h3>Histórico de importações</h3>
        {undoMsg && <p style={{ fontSize: 13 }}>{undoMsg}</p>}
        <table>
          <thead>
            <tr><th>Data</th><th>Arquivo</th><th>Formato</th><th>Status</th><th>Linhas</th><th>Novos</th><th>Atualizados</th><th>Erros</th><th></th></tr>
          </thead>
          <tbody>
            {lotes.map((l) => (
              <Fragment key={l.loteId}>
                <tr>
                  <td>{new Date(l.startedAt).toLocaleString("pt-BR")}</td>
                  <td>{l.nomeArquivo ?? <span style={{ color: "var(--text-muted)" }}>{l.source}</span>}</td>
                  <td>{l.formatoNome ?? "—"}</td>
                  <td>
                    {l.desfeita ? (
                      <span className="badge warn">DESFEITA</span>
                    ) : (
                      <span className={`badge ${l.status === "CONCLUIDO" ? "ok" : l.status === "FALHOU" ? "danger" : l.errorCount ? "warn" : ""}`}>{l.status}</span>
                    )}
                  </td>
                  <td>{l.totalRows}</td>
                  <td>{l.addedCount}</td>
                  <td>{l.updatedCount}</td>
                  <td>{l.errorCount}</td>
                  <td>
                    {l.errorCount > 0 && (
                      <button className="btn secondary" onClick={() => toggleErrors(l.loteId)}>
                        {expanded === l.loteId ? "Ocultar erros" : "Ver erros"}
                      </button>
                    )}{" "}
                    {isAdmin && l.podeDesfazer && (
                      <button className="btn danger" disabled={undoing !== null} onClick={() => handleUndo(l)}>
                        {undoing === l.loteId ? "Desfazendo..." : "Desfazer"}
                      </button>
                    )}
                  </td>
                </tr>
                {expanded === l.loteId && loteErrors[l.loteId] && (
                  <tr>
                    <td colSpan={9}>
                      <div style={{ padding: 8, background: "var(--surface-alt)", borderRadius: 6 }}>
                        <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 0 }}>
                          Corrija a planilha para as linhas abaixo e importe de novo (linhas já existentes só atualizam, não duplicam).
                        </p>
                        <table>
                          <thead><tr><th>Linha</th><th>Motivo</th></tr></thead>
                          <tbody>
                            {loteErrors[l.loteId].slice(0, 50).map((e, i) => (
                              <tr key={i}><td>{e.row}</td><td>{e.motivo}</td></tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {lotes.length === 0 && (
              <tr><td colSpan={9} style={{ color: "var(--text-muted)" }}>Nenhuma importação registrada ainda</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {user?.role === "ADMIN" && (
        <div className="card" style={{ marginTop: 16, borderColor: "var(--danger, #d9534f)" }}>
          <h3>Limpar base</h3>
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
            Apaga <strong>todos os clientes</strong>, com movimentações, compras, histórico de conta, eventos de mensagem e
            as conversas da Inbox desses clientes. Use quando subiu a planilha errada. Não dá para desfazer. Quem pediu
            para sair continua bloqueado na reimportação. Campanhas, segmentos, templates e o histórico de importações são mantidos.
          </p>
          <div className="form-row">
            <label>Digite LIMPAR BASE para confirmar</label>
            <input value={purgeText} onChange={(e) => setPurgeText(e.target.value)} />
          </div>
          <button className="btn danger" disabled={purgeText !== "LIMPAR BASE"} onClick={handlePurge}>
            Limpar base
          </button>
          {purgeMsg && <p style={{ marginTop: 10, fontSize: 13 }}>{purgeMsg}</p>}
        </div>
      )}
    </div>
  );
}

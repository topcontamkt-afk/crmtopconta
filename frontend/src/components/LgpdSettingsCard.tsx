import { FormEvent, ReactNode, useEffect, useState } from "react";
import { api, ApiError } from "../api/client";

/**
 * LGPD 03-06 / 04-07 / 02-01: configuração do controlador (cada empresa no CRM é um controlador distinto).
 * Os valores são DECISÃO DO CONTROLADOR (com o jurídico/encarregado); o sistema só registra e aplica.
 */
interface LgpdConfig {
  baseLegalMarketing: "LEGITIMO_INTERESSE" | "CONSENTIMENTO" | null;
  liaVersao: string | null;
  liaAprovadaEm: string | null;
  controladorNome: string | null;
  encarregadoNome: string | null;
  encarregadoContato: string | null;
  avisoPrivacidadeUrl: string | null;
  rodapeOptOut: string | null;
  retentionDays: number;
  retentionBasis: string | null;
  retentionDaysAfterClosure: number | null;
  inboxRetentionDays: number | null;
  mediaRetentionDays: number;
  correcaoManualVence: boolean;
  rodapeEfetivo: string;
  name: string;
  limitesRetencao: { min: number; max: number };
}

interface Previa {
  prazoAtual: number;
  prazoNovo: number;
  vencidosHoje: number;
  vencidosComNovo: number;
  aMais: number;
}

type Form = Record<string, string | boolean>;

const vazio = (v: string | null | undefined) => v ?? "";
const numOuNull = (v: string | boolean) => (typeof v === "string" && v.trim() ? Number(v) : null);
const txtOuNull = (v: string | boolean) => (typeof v === "string" && v.trim() ? v.trim() : null);

function mensagemErro(e: unknown): string {
  const m = e instanceof Error ? e.message : "Erro inesperado";
  try {
    const v = JSON.parse(m);
    if (typeof v === "string") return v;
    const campos = v?.fieldErrors ? Object.values(v.fieldErrors).flat() : [];
    return [...(v?.formErrors ?? []), ...campos].join(" ") || m;
  } catch {
    return m;
  }
}

function Ajuda({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>{children}</div>;
}

export default function LgpdSettingsCard({ isAdmin }: { isAdmin: boolean }) {
  const [cfg, setCfg] = useState<LgpdConfig | null>(null);
  const [f, setF] = useState<Form>({});
  const [previa, setPrevia] = useState<Previa | null>(null);
  const [confirmar, setConfirmar] = useState(false);
  const [status, setStatus] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);
  const [busy, setBusy] = useState(false);

  function preencher(c: LgpdConfig) {
    setCfg(c);
    setF({
      baseLegalMarketing: vazio(c.baseLegalMarketing),
      liaVersao: vazio(c.liaVersao),
      liaAprovadaEm: vazio(c.liaAprovadaEm),
      controladorNome: vazio(c.controladorNome),
      encarregadoNome: vazio(c.encarregadoNome),
      encarregadoContato: vazio(c.encarregadoContato),
      avisoPrivacidadeUrl: vazio(c.avisoPrivacidadeUrl),
      rodapeOptOut: vazio(c.rodapeOptOut),
      retentionDays: String(c.retentionDays),
      retentionBasis: vazio(c.retentionBasis),
      retentionDaysAfterClosure: c.retentionDaysAfterClosure === null ? "" : String(c.retentionDaysAfterClosure),
      inboxRetentionDays: c.inboxRetentionDays === null ? "" : String(c.inboxRetentionDays),
      mediaRetentionDays: String(c.mediaRetentionDays),
      correcaoManualVence: c.correcaoManualVence,
    });
    setPrevia(null);
    setConfirmar(false);
  }

  useEffect(() => {
    api<LgpdConfig>("/tenant/lgpd").then(preencher).catch((e) => setStatus({ tipo: "erro", texto: mensagemErro(e) }));
  }, []);

  // Prévia ao reduzir o prazo geral: quantos clientes a mais seriam anonimizados (só contagem)
  useEffect(() => {
    if (!cfg || !isAdmin) return;
    const dias = Number(f.retentionDays);
    if (!Number.isInteger(dias) || dias >= cfg.retentionDays || dias < cfg.limitesRetencao.min) {
      setPrevia(null);
      return;
    }
    const t = setTimeout(() => {
      api<Previa>(`/tenant/lgpd/previa-retencao?dias=${dias}`).then(setPrevia).catch(() => setPrevia(null));
    }, 400);
    return () => clearTimeout(t);
  }, [f.retentionDays, cfg, isAdmin]);

  if (!cfg) return status ? <div className="card"><p className="error-text">{status.texto}</p></div> : null;

  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const prazoMudou =
    Number(f.retentionDays) !== cfg.retentionDays ||
    numOuNull(f.retentionDaysAfterClosure) !== cfg.retentionDaysAfterClosure ||
    numOuNull(f.inboxRetentionDays) !== cfg.inboxRetentionDays ||
    Number(f.mediaRetentionDays) !== cfg.mediaRetentionDays;

  async function salvar(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      const body: Record<string, unknown> = {
        baseLegalMarketing: f.baseLegalMarketing || null,
        liaVersao: txtOuNull(f.liaVersao),
        liaAprovadaEm: txtOuNull(f.liaAprovadaEm),
        controladorNome: txtOuNull(f.controladorNome),
        encarregadoNome: txtOuNull(f.encarregadoNome),
        encarregadoContato: txtOuNull(f.encarregadoContato),
        avisoPrivacidadeUrl: txtOuNull(f.avisoPrivacidadeUrl),
        rodapeOptOut: txtOuNull(f.rodapeOptOut),
        retentionDays: Number(f.retentionDays),
        retentionBasis: txtOuNull(f.retentionBasis),
        retentionDaysAfterClosure: numOuNull(f.retentionDaysAfterClosure),
        inboxRetentionDays: numOuNull(f.inboxRetentionDays),
        mediaRetentionDays: Number(f.mediaRetentionDays),
        correcaoManualVence: f.correcaoManualVence === true,
        ...(confirmar ? { confirmarReducao: true } : {}),
      };
      const r = await api<LgpdConfig>("/tenant/lgpd", { method: "PUT", body });
      preencher(r);
      setStatus({ tipo: "ok", texto: "Configuração LGPD salva (registrada na auditoria)." });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setConfirmar(false);
      setStatus({ tipo: "erro", texto: mensagemErro(err) });
    } finally {
      setBusy(false);
    }
  }

  const ro = !isAdmin;
  const semBase = !f.baseLegalMarketing;

  return (
    <form className="card" style={{ marginBottom: 16 }} onSubmit={salvar}>
      <h3>LGPD — dados do controlador</h3>
      <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
        Estas escolhas são <strong>decisão da empresa (controladora dos dados)</strong>, com o apoio do jurídico ou do encarregado. O sistema
        só registra e aplica: bloqueia envios sem base legal, coloca o rodapé nas mensagens e usa os prazos na rotina de retenção. Toda
        alteração fica na auditoria.{ro && " Só administradores alteram."}
      </p>

      <h4 style={{ margin: "12px 0 4px" }}>Base legal das mensagens de marketing</h4>
      <div className="form-row">
        <label>Base legal</label>
        <select value={String(f.baseLegalMarketing)} onChange={set("baseLegalMarketing")} disabled={ro}>
          <option value="">Não declarada (envio de marketing bloqueado)</option>
          <option value="LEGITIMO_INTERESSE">Legítimo interesse (art. 7º, IX)</option>
          <option value="CONSENTIMENTO">Consentimento (art. 7º, I)</option>
        </select>
        <Ajuda>
          Sem base declarada, nenhuma campanha, lista ou automação é enviada. Legítimo interesse exige o teste de balanceamento (LIA) e
          descadastro fácil em toda mensagem; consentimento exige prova de quando e como cada pessoa aceitou.
        </Ajuda>
        {semBase && <div className="error-text" style={{ fontSize: 13 }}>Envio de marketing bloqueado até a base legal ser declarada.</div>}
        {f.baseLegalMarketing === "CONSENTIMENTO" && (
          <div className="error-text" style={{ fontSize: 13 }}>
            O CRM não registra o aceite de cada pessoa (data, canal e texto): a autorização vem da planilha. Com consentimento, a
            prova fica com o controlador, fora do sistema (art. 8º, §2º).
          </div>
        )}
      </div>
      {f.baseLegalMarketing === "LEGITIMO_INTERESSE" && (
        <div className="seg-row">
          <div className="form-row">
            <label>Versão da LIA</label>
            <input value={String(f.liaVersao)} onChange={set("liaVersao")} disabled={ro} placeholder="Ex.: LIA marketing v1" />
            <Ajuda>Identificação do documento do teste de balanceamento aprovado.</Ajuda>
          </div>
          <div className="form-row">
            <label>Aprovada em</label>
            <input type="date" value={String(f.liaAprovadaEm)} onChange={set("liaAprovadaEm")} disabled={ro} />
            <Ajuda>Sem versão e data, o assistente de campanha avisa que a LIA está pendente.</Ajuda>
          </div>
        </div>
      )}

      <h4 style={{ margin: "12px 0 4px" }}>Identificação e canal do titular</h4>
      <div className="seg-row">
        <div className="form-row">
          <label>Nome do controlador nas mensagens</label>
          <input value={String(f.controladorNome)} onChange={set("controladorNome")} disabled={ro} placeholder={cfg.name} />
          <Ajuda>Como a empresa se identifica no rodapé e na resposta automática. Vazio = "{cfg.name}".</Ajuda>
        </div>
        <div className="form-row">
          <label>Encarregado (DPO) ou responsável pelo canal</label>
          <input value={String(f.encarregadoNome)} onChange={set("encarregadoNome")} disabled={ro} />
          <Ajuda>Quem atende os pedidos dos titulares (acesso, correção, eliminação).</Ajuda>
        </div>
      </div>
      <div className="seg-row">
        <div className="form-row">
          <label>Contato do encarregado / canal do titular</label>
          <input value={String(f.encarregadoContato)} onChange={set("encarregadoContato")} disabled={ro} placeholder="E-mail, telefone ou link" />
          <Ajuda>Aparece na resposta automática do WhatsApp para quem quiser falar sobre os próprios dados.</Ajuda>
        </div>
        <div className="form-row">
          <label>Aviso de privacidade (URL)</label>
          <input value={String(f.avisoPrivacidadeUrl)} onChange={set("avisoPrivacidadeUrl")} disabled={ro} placeholder="https://..." />
          <Ajuda>Página pública com o aviso de privacidade (precisa começar com https://).</Ajuda>
        </div>
      </div>
      <div className="form-row">
        <label>Rodapé de descadastro</label>
        <input value={String(f.rodapeOptOut)} onChange={set("rodapeOptOut")} disabled={ro} maxLength={160} placeholder="Responda SAIR para não receber mais mensagens." />
        <Ajuda>
          Vai no fim de todo SMS, mensagem pela Z-API e texto livre. Precisa ensinar a parar (SAIR/PARAR). Vazio = padrão. Hoje sai:{" "}
          <em>{cfg.rodapeEfetivo}</em>. Templates da Meta levam o rodapé ou o botão SAIR do próprio template.
        </Ajuda>
      </div>

      <h4 style={{ margin: "12px 0 4px" }}>Retenção</h4>
      <div className="seg-row">
        <div className="form-row">
          <label>Prazo geral (dias sem uso até anonimizar)</label>
          <input type="number" min={cfg.limitesRetencao.min} max={cfg.limitesRetencao.max} value={String(f.retentionDays)} onChange={set("retentionDays")} disabled={ro} />
          <Ajuda>Entre {cfg.limitesRetencao.min} e {cfg.limitesRetencao.max} dias. Depois do prazo sem uso, o cliente é anonimizado pela rotina diária.</Ajuda>
        </div>
        <div className="form-row">
          <label>Após o encerramento da conta (dias)</label>
          <input type="number" min={cfg.limitesRetencao.min} max={cfg.limitesRetencao.max} value={String(f.retentionDaysAfterClosure)} onChange={set("retentionDaysAfterClosure")} disabled={ro} placeholder="Vazio = prazo geral" />
          <Ajuda>Conta encerrada sai do uso comercial; este é o prazo para anonimizar.</Ajuda>
        </div>
      </div>
      <div className="seg-row">
        <div className="form-row">
          <label>Conversas da Inbox (dias)</label>
          <input type="number" min={cfg.limitesRetencao.min} max={cfg.limitesRetencao.max} value={String(f.inboxRetentionDays)} onChange={set("inboxRetentionDays")} disabled={ro} placeholder="Vazio = prazo geral" />
        </div>
        <div className="form-row">
          <label>Cópias de mídia do WhatsApp (dias)</label>
          <input type="number" min={7} max={cfg.limitesRetencao.max} value={String(f.mediaRetentionDays)} onChange={set("mediaRetentionDays")} disabled={ro} />
        </div>
      </div>
      <div className="form-row">
        <label>Fundamento dos prazos {prazoMudou && <span className="error-text">(obrigatório ao mudar um prazo)</span>}</label>
        <textarea rows={2} value={String(f.retentionBasis)} onChange={set("retentionBasis")} disabled={ro} placeholder="Ex.: prazo prescricional de 5 anos do CDC para relações de consumo" />
        <Ajuda>Por que este prazo: obrigação legal, prazo prescricional ou finalidade. Fica registrado na auditoria.</Ajuda>
      </div>
      {previa && previa.aMais > 0 && (
        <div className="card" style={{ background: "var(--warning-bg, #fff7ed)", padding: 10, marginBottom: 8 }}>
          <strong>Prévia:</strong> com {previa.prazoNovo} dias, <strong>{previa.aMais.toLocaleString("pt-BR")}</strong> cliente(s) a mais serão anonimizados na
          próxima rotina de retenção ({previa.vencidosComNovo.toLocaleString("pt-BR")} no total). Isso não tem volta.
          <label style={{ display: "block", marginTop: 6 }}>
            <input type="checkbox" checked={confirmar} onChange={(e) => setConfirmar(e.target.checked)} disabled={ro} /> Confirmo a redução do prazo
          </label>
        </div>
      )}
      <div className="form-row">
        <label>
          <input type="checkbox" checked={f.correcaoManualVence === true} onChange={(e) => setF((x) => ({ ...x, correcaoManualVence: e.target.checked }))} disabled={ro} /> Correção
          feita no CRM vale sobre a planilha
        </label>
        <Ajuda>Quando o titular pede correção de um dado, a próxima importação não desfaz a correção.</Ajuda>
      </div>

      {isAdmin && (
        <button className="btn" type="submit" disabled={busy || (!!previa && previa.aMais > 0 && !confirmar)}>
          Salvar configuração LGPD
        </button>
      )}
      {status && <p className={status.tipo === "erro" ? "error-text" : ""} style={{ marginTop: 8 }}>{status.texto}</p>}
    </form>
  );
}

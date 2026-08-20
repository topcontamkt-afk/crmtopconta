import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api/client";

const STEPS = ["Nome/objetivo", "Público", "Canal & mensagem", "Agenda & throttling", "Confirmação"];

interface Template {
  id: string;
  channel: "WHATSAPP" | "SMS";
  name: string;
  body: string;
  status: string;
}

export default function CampaignWizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);

  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [cidade, setCidade] = useState("");
  const [faixaUso, setFaixaUso] = useState("");
  const [audiencePreview, setAudiencePreview] = useState<number | null>(null);
  const [channel, setChannel] = useState<"WHATSAPP" | "SMS">("WHATSAPP");

  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [messageTemplate, setMessageTemplate] = useState("Olá {{nome}}, você já utilizou {{percentual}}% do seu limite!");

  const [abEnabled, setAbEnabled] = useState(false);
  const [messageTemplateB, setMessageTemplateB] = useState("");
  const [variantSplitPercent, setVariantSplitPercent] = useState(50);

  const [isSandbox, setIsSandbox] = useState(false);

  const [throttlePerMin, setThrottlePerMin] = useState(60);
  const [dedupeWindowHrs, setDedupeWindowHrs] = useState(72);
  const [attributionDays, setAttributionDays] = useState(7);
  const [scheduledAt, setScheduledAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api<Template[]>(`/templates?channel=${channel}&status=APROVADO`).then(setTemplates);
    setTemplateId("");
  }, [channel]);

  function adHocFilters() {
    return {
      cidade: cidade ? [cidade] : undefined,
      faixaUso: faixaUso ? [faixaUso] : undefined,
    };
  }

  async function previewAudience() {
    const resp = await api<{ count: number }>("/segments/preview", { method: "POST", body: adHocFilters() });
    setAudiencePreview(resp.count);
  }

  const effectiveMessage = templateId ? templates.find((t) => t.id === templateId)?.body || "" : messageTemplate;

  async function handleConfirm() {
    setSubmitting(true);
    setError(null);
    try {
      const campaign = await api<{ id: string }>("/campaigns", {
        method: "POST",
        body: {
          name,
          objective,
          channel,
          adHocFilters: adHocFilters(),
          templateId: templateId || undefined,
          messageTemplate: templateId ? undefined : messageTemplate,
          messageTemplateB: abEnabled ? messageTemplateB : undefined,
          variantSplitPercent: abEnabled ? variantSplitPercent : undefined,
          isSandbox,
          throttlePerMin,
          dedupeWindowHrs,
          attributionDays,
          scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : undefined,
        },
      });
      navigate(`/campaigns/${campaign.id}/report`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro ao criar campanha");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <h2>Nova campanha</h2>
      <div className="wizard-steps">
        {STEPS.map((s, i) => (
          <div key={s} className={`wizard-step ${i === step ? "active" : ""}`}>
            {i + 1}. {s}
          </div>
        ))}
      </div>

      <div className="card">
        {step === 0 && (
          <div>
            <div className="form-row">
              <label>Nome da campanha</label>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="form-row">
              <label>Objetivo</label>
              <input value={objective} onChange={(e) => setObjective(e.target.value)} />
            </div>
          </div>
        )}

        {step === 1 && (
          <div>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <input placeholder="Cidade" value={cidade} onChange={(e) => setCidade(e.target.value)} />
              <select value={faixaUso} onChange={(e) => setFaixaUso(e.target.value)}>
                <option value="">Qualquer faixa</option>
                <option value="NAO_UTILIZOU">Não utilizou</option>
                <option value="BAIXO_USO">Baixo uso</option>
                <option value="USO_INICIAL">Uso inicial</option>
                <option value="USO_INTERMEDIARIO">Uso intermediário</option>
                <option value="USO_ALTO">Uso alto</option>
                <option value="QUASE_COMPLETO">Quase completo</option>
                <option value="LIMITE_COMPLETO">Limite completo</option>
              </select>
              <button type="button" className="btn secondary" onClick={previewAudience}>
                Contar público
              </button>
            </div>
            {audiencePreview !== null && (
              <p>
                <strong>{audiencePreview}</strong> clientes elegíveis (opt-outs já excluídos automaticamente)
              </p>
            )}
            <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Para combinações mais avançadas (grupos AND/OR), salve um segmento em "Segmentos" e
              use a API de campanhas com <code>segmentId</code>.
            </p>
          </div>
        )}

        {step === 2 && (
          <div>
            <div className="form-row">
              <label>Canal</label>
              <select value={channel} onChange={(e) => setChannel(e.target.value as "WHATSAPP" | "SMS")}>
                <option value="WHATSAPP">WhatsApp</option>
                <option value="SMS">SMS</option>
              </select>
            </div>

            <div className="form-row">
              <label>Template aprovado (opcional)</label>
              <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                <option value="">— Texto livre —</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>

            {!templateId && (
              <div className="form-row">
                <label>Mensagem — variante A (placeholders: {"{{nome}}"}, {"{{cidade}}"}, {"{{percentual}}"})</label>
                <textarea rows={4} value={messageTemplate} onChange={(e) => setMessageTemplate(e.target.value)} />
              </div>
            )}

            <div className="card" style={{ background: "var(--surface-alt)" }}>
              <strong>Pré-visualização (variante A):</strong>
              <p>{effectiveMessage.replace("{{nome}}", "Maria").replace("{{cidade}}", cidade || "São Paulo").replace("{{percentual}}", "45")}</p>
            </div>

            <div className="form-row" style={{ marginTop: 10 }}>
              <label>
                <input type="checkbox" checked={abEnabled} onChange={(e) => setAbEnabled(e.target.checked)} /> Testar variante B (A/B testing)
              </label>
            </div>
            {abEnabled && (
              <>
                <div className="form-row">
                  <label>Mensagem — variante B</label>
                  <textarea rows={3} value={messageTemplateB} onChange={(e) => setMessageTemplateB(e.target.value)} />
                </div>
                <div className="form-row">
                  <label>% do público que recebe a variante B</label>
                  <input type="number" min={0} max={100} value={variantSplitPercent} onChange={(e) => setVariantSplitPercent(Number(e.target.value))} />
                </div>
              </>
            )}
          </div>
        )}

        {step === 3 && (
          <div>
            <div className="form-row">
              <label>Data/hora de agendamento</label>
              <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
            </div>
            <div className="form-row">
              <label>Taxa máxima (mensagens/minuto)</label>
              <input type="number" value={throttlePerMin} onChange={(e) => setThrottlePerMin(Number(e.target.value))} />
            </div>
            <div className="form-row">
              <label>Janela mínima entre envios repetidos (horas)</label>
              <input type="number" value={dedupeWindowHrs} onChange={(e) => setDedupeWindowHrs(Number(e.target.value))} />
            </div>
            <div className="form-row">
              <label>Janela de atribuição de conversão (dias)</label>
              <input type="number" value={attributionDays} onChange={(e) => setAttributionDays(Number(e.target.value))} />
            </div>
            <div className="form-row">
              <label>
                <input type="checkbox" checked={isSandbox} onChange={(e) => setIsSandbox(e.target.checked)} /> Campanha de teste/sandbox (não conta para relatórios agregados)
              </label>
            </div>
          </div>
        )}

        {step === 4 && (
          <div>
            <p><strong>Nome:</strong> {name}</p>
            <p><strong>Canal:</strong> {channel}</p>
            <p><strong>Público estimado:</strong> {audiencePreview ?? "não calculado"}</p>
            <p><strong>Mensagem (A):</strong> {effectiveMessage}</p>
            {abEnabled && <p><strong>Mensagem (B):</strong> {messageTemplateB} — {variantSplitPercent}% do público</p>}
            <p><strong>Throttle:</strong> {throttlePerMin} msgs/min · Dedupe: {dedupeWindowHrs}h · Atribuição: {attributionDays} dias</p>
            {isSandbox && <p><span className="badge warn">Sandbox</span> esta campanha é de teste</p>}
            <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Após criar, você pode enviar uma amostra de teste (QA) antes de agendar para a base completa, na tela de relatório da campanha.
            </p>
            {error && <div className="error-text">{error}</div>}
          </div>
        )}

        <div style={{ marginTop: 16, display: "flex", justifyContent: "space-between" }}>
          <button className="btn secondary" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>
            Voltar
          </button>
          {step < STEPS.length - 1 ? (
            <button className="btn" onClick={() => setStep((s) => s + 1)} disabled={!name && step === 0}>
              Próximo
            </button>
          ) : (
            <button className="btn" onClick={handleConfirm} disabled={submitting}>
              {submitting ? "Criando..." : "Confirmar e criar campanha"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

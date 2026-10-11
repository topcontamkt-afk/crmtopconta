import { TEMPLATE_VARIABLES, variablesIn } from "./templateVariables";
import { WHATSAPP_API_VERSION } from "./whatsappMedia";
import { SendError, explainMetaError } from "./whatsappSend";

/**
 * Templates do WhatsApp (Meta). Fora da janela de 24 horas só vale template APROVADO pela Meta.
 * Aqui: validação local das regras da Meta, conversão do nosso texto ({{nome}}) para o formato
 * posicional da Meta ({{1}}), criação/consulta/exclusão na Graph API e o envio do template.
 *
 * As regras de validação são as que a Meta costuma reprovar; a lista oficial muda com o tempo,
 * então a aprovação final é sempre da Meta (o status volta por webhook ou pela sincronização).
 */

export const TEMPLATE_CATEGORIES = ["MARKETING", "UTILITY"] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const BODY_MAX = 1024;
export const FOOTER_MAX = 60;
export const QUICK_REPLY_MAX = 3;
export const QUICK_REPLY_TEXT_MAX = 25;

/** Valores de exemplo exigidos pela Meta para cada variável no momento de criar o template. */
export const SAMPLE_VALUES: Record<string, string> = {
  nome: "Maria",
  cidade: "Natal",
  percentual: "45",
  saldo: "R$ 850,00",
  limite: "R$ 1.500,00",
};

export interface TemplateDraft {
  body: string;
  footer?: string | null;
  quickReplies?: string[] | null;
  category?: string | null;
}

/** Variáveis do texto, sem repetir, na ordem em que aparecem ({{1}} = primeira, {{2}} = segunda...). */
export function variableOrder(body: string): string[] {
  return [...new Set(variablesIn(body))];
}

/** "Olá {{nome}}, seu limite é {{limite}}" -> "Olá {{1}}, seu limite é {{2}}" */
export function toMetaBody(body: string): string {
  const order = variableOrder(body);
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, v) => `{{${order.indexOf(v) + 1}}}`);
}

export function validateTemplate(t: TemplateDraft): string[] {
  const erros: string[] = [];
  const body = t.body ?? "";
  if (!body.trim()) erros.push("Escreva o texto do template.");
  if (body.length > BODY_MAX) erros.push(`O texto passa de ${BODY_MAX} caracteres.`);

  const desconhecidas = variableOrder(body).filter((v) => !(TEMPLATE_VARIABLES as readonly string[]).includes(v));
  if (desconhecidas.length) erros.push(`Variáveis desconhecidas: ${desconhecidas.map((v) => `{{${v}}}`).join(", ")}. Use só ${TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(", ")}.`);

  const trimmed = body.trim();
  if (/^\{\{[^}]*\}\}/.test(trimmed)) erros.push("O texto não pode começar com uma variável. Comece com uma palavra (ex.: \"Olá {{nome}}\").");
  if (/\{\{[^}]*\}\}$/.test(trimmed)) erros.push("O texto não pode terminar com uma variável. Termine com uma palavra ou pontuação.");
  if (/\}\}\s*\{\{/.test(body)) erros.push("Não deixe duas variáveis coladas: coloque texto entre elas.");
  if (/\n{3,}/.test(body)) erros.push("Evite mais de uma linha em branco seguida.");

  if (t.footer) {
    if (t.footer.length > FOOTER_MAX) erros.push(`O rodapé passa de ${FOOTER_MAX} caracteres.`);
    if (/\{\{/.test(t.footer)) erros.push("O rodapé não aceita variáveis.");
  }

  const botoes = (t.quickReplies ?? []).map((b) => b.trim()).filter(Boolean);
  if (botoes.length > QUICK_REPLY_MAX) erros.push(`No máximo ${QUICK_REPLY_MAX} botões de resposta rápida.`);
  for (const b of botoes) if (b.length > QUICK_REPLY_TEXT_MAX) erros.push(`O botão "${b}" passa de ${QUICK_REPLY_TEXT_MAX} caracteres.`);
  if (new Set(botoes.map((b) => b.toLowerCase())).size !== botoes.length) erros.push("Há botões com o mesmo texto.");

  if (!t.category || !(TEMPLATE_CATEGORIES as readonly string[]).includes(t.category)) erros.push("Escolha a categoria: Marketing ou Utilidade.");
  return erros;
}

/** Nome na Meta: minúsculas, números e _ (até 512). Sobe a versão a cada edição reenviada. */
export function metaTemplateName(localName: string, version: number): string {
  const slug = localName
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return `${slug || "template"}_v${version}`;
}

export function buildCreatePayload(t: TemplateDraft & { name: string; language: string; version: number }) {
  const order = variableOrder(t.body);
  const components: any[] = [
    {
      type: "BODY",
      text: toMetaBody(t.body),
      ...(order.length ? { example: { body_text: [order.map((v) => SAMPLE_VALUES[v] ?? "exemplo")] } } : {}),
    },
  ];
  if (t.footer?.trim()) components.push({ type: "FOOTER", text: t.footer.trim() });
  const botoes = (t.quickReplies ?? []).map((b) => b.trim()).filter(Boolean);
  if (botoes.length) components.push({ type: "BUTTONS", buttons: botoes.map((text) => ({ type: "QUICK_REPLY", text })) });
  return { name: metaTemplateName(t.name, t.version), language: t.language, category: t.category, components };
}

/**
 * Parâmetros do corpo na ordem de {{1}}, {{2}}... A Meta recusa parâmetro vazio, com quebra de linha,
 * tabulação ou 4+ espaços seguidos — por isso o valor é higienizado.
 */
export function buildBodyParams(body: string, context: Record<string, unknown>): string[] {
  return variableOrder(body).map((v) => {
    const raw = context[v];
    const text = String(raw ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim();
    return text || "-";
  });
}

/** Texto final que o cliente vê (para guardar na conversa e na pré-visualização). */
export function renderMetaPreview(body: string, params: string[]): string {
  const order = variableOrder(body);
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, v) => params[order.indexOf(v)] ?? "");
}

/** Status da Meta -> status local. PAUSED/DISABLED não podem ser usados em envio. */
export function mapMetaStatus(metaStatus: string | null | undefined): "PENDENTE_APROVACAO" | "APROVADO" | "REJEITADO" | null {
  switch ((metaStatus ?? "").toUpperCase()) {
    case "APPROVED":
      return "APROVADO";
    case "PENDING":
    case "IN_APPEAL":
    case "PENDING_DELETION":
      return "PENDENTE_APROVACAO";
    case "REJECTED":
    case "PAUSED":
    case "DISABLED":
    case "LIMIT_EXCEEDED":
      return "REJEITADO";
    default:
      return null;
  }
}

/** Motivo legível para templates que a Meta reprovou, pausou ou desativou. */
export function explainTemplateIssue(metaStatus: string | null | undefined, reason?: string | null): string | null {
  const s = (metaStatus ?? "").toUpperCase();
  const motivo = reason && reason !== "NONE" ? ` (${reason})` : "";
  if (s === "REJECTED") return `Reprovado pela Meta${motivo}. Ajuste o texto e envie de novo.`;
  if (s === "PAUSED") return "Pausado pela Meta por baixa qualidade (muitos bloqueios ou denúncias). Aguarde ou revise o texto.";
  if (s === "DISABLED") return `Desativado pela Meta${motivo}.`;
  return null;
}

// ----------------------------------------------------------------------------------------------
// Graph API
// ----------------------------------------------------------------------------------------------

type FetchLike = (url: string, init?: any) => Promise<any>;
const timeout = () => AbortSignal.timeout(20_000);
const root = (id: string) => `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${encodeURIComponent(id)}`;

function metaError(j: any, status: number): SendError {
  const err = j?.error ?? {};
  const code = typeof err.code === "number" ? err.code : undefined;
  const sub = typeof err.error_subcode === "number" ? err.error_subcode : undefined;
  const detalhe = err.error_user_msg || err.error_user_title || err.message || `HTTP ${status}`;
  const especifico: Record<number, string> = {
    2388023: "Já existe um template com este nome e idioma na Meta (talvez em exclusão). Aguarde alguns minutos ou mude o nome.",
    2388024: "Já existe um template com este nome na Meta. Edite o texto para gerar uma nova versão.",
    2388299: "A Meta recusou o conteúdo do template. Revise o texto.",
  };
  const msg = (sub !== undefined && especifico[sub]) || explainMetaError(code, `A Meta recusou: ${detalhe}`);
  return new SendError("META", msg, code);
}

async function call(url: string, token: string | undefined, init: any, fetchImpl: FetchLike): Promise<any> {
  if (!token) throw new SendError("SEM_TOKEN", "Token de acesso da Meta não configurado (Integrações > WhatsApp).");
  let r: any;
  try {
    r = await fetchImpl(url, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, signal: timeout() });
  } catch (e) {
    throw new SendError("META", `Não foi possível falar com a Meta: ${(e as Error).message}`);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw metaError(j, r.status);
  return j;
}

export interface MetaTemplate {
  id: string;
  name: string;
  status: string;
  category?: string;
  language?: string;
  rejected_reason?: string;
  quality_score?: { score?: string };
}

export async function createMetaTemplate(wabaId: string, token: string | undefined, payload: unknown, fetchImpl: FetchLike = fetch as any): Promise<{ id: string; status: string; category?: string }> {
  const j = await call(`${root(wabaId)}/message_templates`, token, { method: "POST", body: JSON.stringify(payload) }, fetchImpl);
  if (!j?.id) throw new SendError("META", "A Meta não devolveu o id do template.");
  return { id: String(j.id), status: String(j.status ?? "PENDING"), category: j.category };
}

/** Lista todos os templates da conta (segue a paginação, com teto de segurança). */
export async function listMetaTemplates(wabaId: string, token: string | undefined, fetchImpl: FetchLike = fetch as any): Promise<MetaTemplate[]> {
  const out: MetaTemplate[] = [];
  let url: string | null = `${root(wabaId)}/message_templates?fields=id,name,status,category,language,rejected_reason,quality_score&limit=100`;
  for (let page = 0; url && page < 10; page++) {
    const j: any = await call(url, token, { method: "GET" }, fetchImpl);
    out.push(...(j?.data ?? []));
    url = j?.paging?.next ?? null;
  }
  return out;
}

export async function deleteMetaTemplate(wabaId: string, token: string | undefined, name: string, fetchImpl: FetchLike = fetch as any): Promise<void> {
  await call(`${root(wabaId)}/message_templates?name=${encodeURIComponent(name)}`, token, { method: "DELETE" }, fetchImpl);
}

/** Envia um template aprovado a um telefone (fora ou dentro da janela). */
export async function sendTemplateMessage(
  phoneNumberId: string,
  token: string | undefined,
  to: string,
  name: string,
  language: string,
  bodyParams: string[],
  fetchImpl: FetchLike = fetch as any
): Promise<string> {
  const template: any = { name, language: { code: language } };
  if (bodyParams.length) template.components = [{ type: "body", parameters: bodyParams.map((text) => ({ type: "text", text })) }];
  const j = await call(
    `${root(phoneNumberId)}/messages`,
    token,
    { method: "POST", body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "template", template }) },
    fetchImpl
  );
  const wamid = j?.messages?.[0]?.id;
  if (!wamid) throw new SendError("META", "A Meta aceitou, mas não devolveu o id da mensagem.");
  return String(wamid);
}

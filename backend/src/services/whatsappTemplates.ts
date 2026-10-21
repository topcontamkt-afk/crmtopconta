import { mencionaOptOut, TEMPLATE_VARIABLES, variablesIn } from "./templateVariables";
import { WHATSAPP_API_VERSION } from "./whatsappMedia";
import { SendError, explainMetaError } from "./whatsappSend";
import { trackedUrlExample, trackedUrlPattern } from "./trackedLinks";

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
export const QUICK_REPLY_MAX = 10;
export const BUTTONS_MAX = 10;
export const URL_BUTTON_MAX = 2;
export const PHONE_BUTTON_MAX = 1;
export const URL_MAX = 2000;
export const LANGUAGES = ["pt_BR", "en_US", "es"] as const;

/** Botão de chamada para ação (link ou telefone). Resposta rápida fica em `quickReplies`. */
export interface CtaButton {
  type: "URL" | "PHONE_NUMBER";
  text: string;
  /** destino do link (com `tracked`, é o destino REAL: a Meta recebe só o nosso endereço de redirecionamento) */
  url?: string;
  /** link rastreado: passa por /r/<código> no nosso domínio, que registra o clique (services/trackedLinks.ts) */
  tracked?: boolean;
  phone?: string;
}

/** Telefone do botão "Ligar": +DDI+número, só dígitos (8 a 15). Devolve null se não parecer um telefone. */
export function normalizeButtonPhone(raw: string): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  // sem DDI informado (10-11 dígitos de DDD+número do Brasil): assume 55
  const full = digits.length <= 11 ? `55${digits}` : digits;
  return `+${full}`;
}
export const QUICK_REPLY_TEXT_MAX = 25;

/** Valores de exemplo exigidos pela Meta para cada variável no momento de criar o template. */
export const SAMPLE_VALUES: Record<string, string> = {
  nome: "Maria",
  cidade: "Natal",
  percentual: "45",
  saldo: "R$ 850,00",
  limite: "R$ 1.500,00",
  limite_disponivel: "R$ 850,00",
};

export interface TemplateDraft {
  body: string;
  footer?: string | null;
  quickReplies?: string[] | null;
  buttons?: CtaButton[] | null;
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

/**
 * LGPD 02-05: o template ensina a parar de receber? Rodapé com a instrução ("Responda SAIR...") ou botão de
 * resposta rápida de saída (SAIR, PARAR...). O toque no botão descadastra (whatsappInbox).
 */
export function templateTemOptOut(t: { footer?: string | null; quickReplies?: unknown }): boolean {
  const botoes = Array.isArray(t.quickReplies) ? (t.quickReplies as unknown[]).filter((b): b is string => typeof b === "string") : [];
  return mencionaOptOut(t.footer) || botoes.some((b) => mencionaOptOut(b));
}

/** Valida um template criado ou editado por nós (os importados da Meta não passam por aqui: só leitura). */
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

  // Botões de link e de ligar (chamada para ação)
  const ctas = t.buttons ?? [];
  if (botoes.length + ctas.length > BUTTONS_MAX) erros.push(`No máximo ${BUTTONS_MAX} botões no total.`);
  if (ctas.filter((b) => b.type === "URL").length > URL_BUTTON_MAX) erros.push(`No máximo ${URL_BUTTON_MAX} botões de link.`);
  if (ctas.filter((b) => b.type === "PHONE_NUMBER").length > PHONE_BUTTON_MAX) erros.push(`No máximo ${PHONE_BUTTON_MAX} botão de ligar.`);
  for (const b of ctas) {
    const rotulo = b.text?.trim() || (b.type === "URL" ? "de link" : "de ligar");
    if (!b.text?.trim()) erros.push(`Informe o texto do botão ${rotulo}.`);
    else if (b.text.trim().length > QUICK_REPLY_TEXT_MAX) erros.push(`O botão "${b.text.trim()}" passa de ${QUICK_REPLY_TEXT_MAX} caracteres.`);
    if (b.type === "URL") {
      const url = (b.url ?? "").trim();
      let ok = false;
      try {
        ok = new URL(url).protocol === "https:";
      } catch {
        ok = false;
      }
      if (!url) erros.push(`Informe o link do botão "${rotulo}".`);
      else if (/\{\{/.test(url)) erros.push(`O link do botão "${rotulo}" não pode ter variável.`);
      else if (!ok) erros.push(`O link do botão "${rotulo}" precisa começar com https:// e ser um endereço válido.`);
      else if (url.length > URL_MAX) erros.push(`O link do botão "${rotulo}" passa de ${URL_MAX} caracteres.`);
    } else if (!normalizeButtonPhone(b.phone ?? "")) {
      erros.push(`Informe um telefone válido (com DDD) no botão "${rotulo}".`);
    }
  }
  const textos = [...botoes, ...ctas.map((b) => (b.text ?? "").trim()).filter(Boolean)].map((x) => x.toLowerCase());
  if (new Set(textos).size !== textos.length) erros.push("Há botões com o mesmo texto.");

  if (!t.category || !(TEMPLATE_CATEGORIES as readonly string[]).includes(t.category)) erros.push("Escolha a categoria: Marketing ou Utilidade.");
  // Rodapé/botão de saída não é mais exigido ao salvar; o assistente de campanha só avisa (ver campaignWizard).
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

export function buildCreatePayload(t: TemplateDraft & { name: string; language: string; version: number; headerHandle?: string | null; linkBase?: string }) {
  const order = variableOrder(t.body);
  const components: any[] = [
    ...(t.headerHandle ? [{ type: "HEADER", format: "IMAGE", example: { header_handle: [t.headerHandle] } }] : []),
    {
      type: "BODY",
      text: toMetaBody(t.body),
      ...(order.length ? { example: { body_text: [order.map((v) => SAMPLE_VALUES[v] ?? "exemplo")] } } : {}),
    },
  ];
  if (t.footer?.trim()) components.push({ type: "FOOTER", text: t.footer.trim() });
  const botoes = (t.quickReplies ?? []).map((b) => b.trim()).filter(Boolean);
  const ctaButtons = (t.buttons ?? []).map((b) =>
    b.type === "URL" && b.tracked
      ? (() => {
          if (!t.linkBase) throw new Error("Falta o domínio dos links rastreados (LINK_BASE_URL).");
          return { type: "URL", text: b.text.trim(), url: trackedUrlPattern(t.linkBase), example: [trackedUrlExample(t.linkBase)] };
        })()
      : b.type === "URL"
        ? { type: "URL", text: b.text.trim(), url: (b.url ?? "").trim() }
        : { type: "PHONE_NUMBER", text: b.text.trim(), phone_number: normalizeButtonPhone(b.phone ?? "") ?? "" }
  );
  const allButtons = [...botoes.map((text) => ({ type: "QUICK_REPLY", text })), ...ctaButtons];
  if (allButtons.length) components.push({ type: "BUTTONS", buttons: allButtons });
  return { name: metaTemplateName(t.name, t.version), language: t.language, category: t.category, components };
}

/**
 * Parâmetros do corpo na ordem de {{1}}, {{2}}... A Meta recusa parâmetro vazio, com quebra de linha,
 * tabulação ou 4+ espaços seguidos — por isso o valor é higienizado.
 */
export function sanitizeParam(raw: unknown): string {
  const text = String(raw ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim();
  return text || "-";
}

export function buildBodyParams(body: string, context: Record<string, unknown>): string[] {
  return variableOrder(body).map((v) => sanitizeParam(context[v]));
}

/**
 * Parâmetros do corpo de qualquer template: os importados da Meta seguem o `variableMap` (posição ->
 * variável nossa); os criados aqui seguem a ordem das variáveis do texto.
 */
export function templateParams(t: { body: string; variableMap?: unknown }, context: Record<string, unknown>): string[] {
  if (Array.isArray(t.variableMap)) return (t.variableMap as (string | null)[]).map((v) => sanitizeParam(v ? context[v] : ""));
  return buildBodyParams(t.body, context);
}

/** Texto final de qualquer template com os parâmetros no lugar (importado: posições; local: nomes). */
export function templatePreview(t: { body: string; metaBody?: string | null; variableMap?: unknown }, params: string[]): string {
  if (t.metaBody && Array.isArray(t.variableMap)) return t.metaBody.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => params[Number(n) - 1] ?? "");
  return renderMetaPreview(t.body, params);
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
  parameter_format?: string;
  components?: any[];
}

export async function createMetaTemplate(wabaId: string, token: string | undefined, payload: unknown, fetchImpl: FetchLike = fetch as any): Promise<{ id: string; status: string; category?: string }> {
  const j = await call(`${root(wabaId)}/message_templates`, token, { method: "POST", body: JSON.stringify(payload) }, fetchImpl);
  if (!j?.id) throw new SendError("META", "A Meta não devolveu o id do template.");
  return { id: String(j.id), status: String(j.status ?? "PENDING"), category: j.category };
}

/** Lista todos os templates da conta (segue a paginação, com teto de segurança). */
export async function listMetaTemplates(wabaId: string, token: string | undefined, fetchImpl: FetchLike = fetch as any): Promise<MetaTemplate[]> {
  const out: MetaTemplate[] = [];
  let url: string | null = `${root(wabaId)}/message_templates?fields=id,name,status,category,language,rejected_reason,quality_score,parameter_format,components&limit=100`;
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
  fetchImpl: FetchLike = fetch as any,
  headerImageId?: string,
  buttonTokens?: { index: number; token: string }[]
): Promise<string> {
  const template: any = { name, language: { code: language } };
  const components: any[] = [];
  if (headerImageId) components.push({ type: "header", parameters: [{ type: "image", image: { id: headerImageId } }] });
  if (bodyParams.length) components.push({ type: "body", parameters: bodyParams.map((text) => ({ type: "text", text })) });
  // Botão de link rastreado: o parâmetro é o código assinado que completa o endereço aprovado (/r/{{1}}).
  for (const b of buttonTokens ?? []) components.push({ type: "button", sub_type: "url", index: String(b.index), parameters: [{ type: "text", text: b.token }] });
  if (components.length) template.components = components;
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


/**
 * Upload resumível da Meta: devolve o "handle" da imagem de exemplo exigido ao criar um template com
 * cabeçalho de imagem. Precisa do ID do app (Integrações). Dois passos: abre a sessão e envia os bytes.
 */
export async function uploadTemplateExample(
  appId: string,
  token: string | undefined,
  data: Buffer,
  mime: string,
  filename: string,
  fetchImpl: FetchLike = fetch as any
): Promise<string> {
  if (!token) throw new SendError("SEM_TOKEN", "Token de acesso da Meta não configurado (Integrações > WhatsApp).");
  const open = await fetchImpl(
    `${root(appId)}/uploads?file_length=${data.length}&file_type=${encodeURIComponent(mime)}&file_name=${encodeURIComponent(filename)}`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: timeout() }
  ).catch((e: Error) => {
    throw new SendError("META", `Não foi possível falar com a Meta: ${e.message}`);
  });
  const oj = await open.json().catch(() => ({}));
  if (!open.ok || !oj?.id) throw metaError(oj, open.status);

  const up = await fetchImpl(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${oj.id}`, {
    method: "POST",
    headers: { Authorization: `OAuth ${token}`, file_offset: "0", "Content-Type": "application/octet-stream" },
    body: new Uint8Array(data),
    signal: AbortSignal.timeout(30_000),
  }).catch((e: Error) => {
    throw new SendError("META", `Não foi possível enviar a imagem à Meta: ${e.message}`);
  });
  const uj = await up.json().catch(() => ({}));
  if (!up.ok || !uj?.h) throw metaError(uj, up.status);
  return String(uj.h);
}

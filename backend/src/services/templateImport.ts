import { TEMPLATE_VARIABLES } from "./templateVariables";
import { MetaTemplate, TEMPLATE_CATEGORIES } from "./whatsappTemplates";

/**
 * Templates que já existem na Meta (criados no painel deles ou em outro sistema) entram no nosso
 * cadastro na sincronização. A Meta guarda o texto com variáveis posicionais ({{1}}, {{2}}...), sem
 * dizer o que cada uma significa; por isso o template importado leva um `variableMap` (qual variável
 * nossa preenche cada posição) que a pessoa confere na tela. Este módulo é puro (sem banco).
 */

export type VariableMap = (string | null)[];

export interface ImportedTemplate {
  body: string;
  metaBody: string;
  variableMap: VariableMap;
  footer: string | null;
  quickReplies: string[];
  buttons: { type: string; text: string; url?: string; phone?: string }[];
  headerFormat: "IMAGE" | null;
  headerExampleUrl: string | null;
  category: "MARKETING" | "UTILITY" | null;
  language: string;
  sendIssue: string | null;
}

const OUR_VARS = TEMPLATE_VARIABLES as readonly string[];

/** Palpite do que a variável significa, olhando o exemplo que a Meta guarda. A pessoa confirma na tela. */
export function guessVariable(example: string | undefined, position: number): string | null {
  const ex = (example ?? "").trim();
  if (/^R\$/i.test(ex)) return "limite_disponivel";
  if (/%|^\d+$/.test(ex)) return "percentual";
  if (position === 0 && ex && /^[\p{L}\s.'-]+$/u.test(ex)) return "nome";
  if (position === 0 && !ex) return "nome";
  return null;
}

/** Posições usadas no texto ({{1}}, {{2}}...), em ordem crescente e sem repetir. */
export function positionsIn(text: string): number[] {
  const set = new Set<number>();
  for (const m of text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) set.add(Number(m[1]));
  return [...set].sort((a, b) => a - b);
}

/** Texto com as posições trocadas pelo nome da variável nossa (as não mapeadas ficam como {{n}}). */
export function applyVariableMap(metaBody: string, map: VariableMap): string {
  return metaBody.replace(/\{\{\s*(\d+)\s*\}\}/g, (all, n) => {
    const v = map[Number(n) - 1];
    return v ? `{{${v}}}` : all;
  });
}

export function unmappedPositions(map: VariableMap | null | undefined): number[] {
  return (map ?? []).flatMap((v, i) => (v ? [] : [i + 1]));
}

export function validateVariableMap(map: unknown, expectedLength: number): string | null {
  if (!Array.isArray(map) || map.length !== expectedLength) return `O mapa de variáveis precisa ter ${expectedLength} posição(ões).`;
  for (const v of map) if (v !== null && !OUR_VARS.includes(String(v))) return `Variável desconhecida: ${String(v)}.`;
  return null;
}

/** Converte um template da Meta (componentes) para o nosso formato. */
export function importMetaTemplate(m: MetaTemplate): ImportedTemplate {
  const comps: any[] = Array.isArray(m.components) ? m.components : [];
  const body = comps.find((c) => c.type === "BODY");
  const header = comps.find((c) => c.type === "HEADER");
  const footer = comps.find((c) => c.type === "FOOTER");
  const buttonsComp = comps.find((c) => c.type === "BUTTONS");
  const issues: string[] = [];

  const metaBody = String(body?.text ?? "");
  const named = String(m.parameter_format ?? "").toUpperCase() === "NAMED" || /\{\{\s*[a-z_]+\s*\}\}/i.test(metaBody.replace(/\{\{\s*\d+\s*\}\}/g, ""));
  if (named) issues.push("Usa variáveis nomeadas (formato novo da Meta), que ainda não são suportadas.");

  const positions = positionsIn(metaBody);
  const examples: string[] = (body?.example?.body_text?.[0] as string[] | undefined) ?? [];
  const variableMap: VariableMap = positions.map((_, i) => guessVariable(examples[i], i));

  // Cabeçalho
  let headerFormat: "IMAGE" | null = null;
  let headerExampleUrl: string | null = null;
  if (header) {
    const f = String(header.format ?? "").toUpperCase();
    if (f === "IMAGE") {
      headerFormat = "IMAGE";
      const h = header.example?.header_handle?.[0];
      headerExampleUrl = typeof h === "string" && /^https?:\/\//.test(h) ? h : null;
    } else if (f === "TEXT") {
      if (/\{\{/.test(String(header.text ?? ""))) issues.push("O cabeçalho de texto tem variável, o que ainda não é suportado.");
    } else {
      issues.push(`Cabeçalho de ${f === "VIDEO" ? "vídeo" : f === "DOCUMENT" ? "documento" : f.toLowerCase()} ainda não é suportado.`);
    }
  }

  // Botões
  const quickReplies: string[] = [];
  const buttons: ImportedTemplate["buttons"] = [];
  for (const b of buttonsComp?.buttons ?? []) {
    const t = String(b.type ?? "").toUpperCase();
    if (t === "QUICK_REPLY") quickReplies.push(String(b.text ?? ""));
    else if (t === "URL") {
      if (/\{\{/.test(String(b.url ?? ""))) issues.push(`O botão "${b.text}" tem link com variável, o que ainda não é suportado.`);
      else buttons.push({ type: "URL", text: String(b.text ?? ""), url: String(b.url ?? "") });
    } else if (t === "PHONE_NUMBER") buttons.push({ type: "PHONE_NUMBER", text: String(b.text ?? ""), phone: String(b.phone_number ?? "") });
    else issues.push(`Botão do tipo ${t} ainda não é suportado.`);
  }

  const cat = String(m.category ?? "").toUpperCase();
  if (cat === "AUTHENTICATION") issues.push("Template de autenticação não é usado em campanhas.");
  const category = (TEMPLATE_CATEGORIES as readonly string[]).includes(cat) ? (cat as "MARKETING" | "UTILITY") : null;

  if (!metaBody.trim()) issues.push("O template não tem texto.");

  return {
    body: applyVariableMap(metaBody, variableMap),
    metaBody,
    variableMap,
    footer: footer?.text ? String(footer.text) : null,
    quickReplies,
    buttons,
    headerFormat,
    headerExampleUrl,
    category,
    language: m.language ?? "pt_BR",
    sendIssue: issues.length ? issues.join(" ") : null,
  };
}

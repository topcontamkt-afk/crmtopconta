/** Variáveis aceitas nos textos de campanha/template: {{nome}}, {{cidade}}, {{percentual}}, {{saldo}}, {{limite}}, {{limite_disponivel}} (mesmo valor de saldo: o limite que o cliente ainda pode usar). */
export const TEMPLATE_VARIABLES = ["nome", "cidade", "percentual", "saldo", "limite", "limite_disponivel"] as const;

/** Variáveis `{{x}}` usadas num texto (para validar mensagens sugeridas). */
export function variablesIn(text: string): string[] {
  return Array.from(text.matchAll(/\{\{\s*(\w+)\s*\}\}/g), (m) => m[1]);
}

/* ───────────────────────── LGPD 02-05 / 02-07: rodapé do controlador ───────────────────────── */

/** Campos do Tenant usados para identificar o controlador nas mensagens. */
export interface ControladorInfo {
  name?: string | null;
  controladorNome?: string | null;
  rodapeOptOut?: string | null;
}

/** Instrução de descadastro padrão (a palavra SAIR é reconhecida na entrada: whatsappPayload.isOptOutMessage). */
export const INSTRUCAO_OPT_OUT = "Responda SAIR para não receber mais mensagens.";

const normalizar = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** O texto ensina a parar (SAIR, PARAR, STOP, descadastrar...)? Usado no rodapé e nos botões de template. */
export function mencionaOptOut(texto: string | null | undefined): boolean {
  if (!texto) return false;
  return /\b(sair|parar|pare|stop|cancelar|descadastr\w*)\b/.test(normalizar(texto));
}

/** Nome que identifica o controlador: o configurado em Configurações → LGPD, senão o nome do tenant. */
export function nomeControlador(t: ControladorInfo): string {
  return (t.controladorNome ?? "").trim() || (t.name ?? "").trim();
}

/**
 * LGPD 02-05: rodapé de toda mensagem de marketing em texto livre (SMS, Z-API, texto livre no WhatsApp):
 * identifica o controlador e ensina a parar. Usa `Tenant.rodapeOptOut` quando configurado (prefixado com o
 * nome do controlador se o texto não o trouxer, e com a instrução padrão se não ensinar a parar); sem texto
 * próprio, o padrão "<controlador>: Responda SAIR para não receber mais mensagens."
 */
export function montarRodape(t: ControladorInfo): string {
  const controlador = nomeControlador(t);
  const proprio = (t.rodapeOptOut ?? "").trim();
  if (!proprio) return controlador ? `${controlador}: ${INSTRUCAO_OPT_OUT}` : INSTRUCAO_OPT_OUT;
  let texto = proprio;
  if (!mencionaOptOut(texto)) texto = `${texto} ${INSTRUCAO_OPT_OUT}`;
  if (controlador && !normalizar(texto).includes(normalizar(controlador))) texto = `${controlador}: ${texto}`;
  return texto;
}

/** Acrescenta o rodapé ao texto (uma linha em branco antes), sem repetir quando o texto já termina com ele. */
export function comRodape(texto: string, rodape: string): string {
  const corpo = texto.trimEnd();
  if (!rodape.trim() || corpo.endsWith(rodape.trim())) return corpo;
  return `${corpo}\n\n${rodape.trim()}`;
}

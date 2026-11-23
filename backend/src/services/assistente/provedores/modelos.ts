import Anthropic from "@anthropic-ai/sdk";
import { NomeProvedor } from "./tipos";

/** Modelos sugeridos (a lista ao vivo, pela chave de cada provedor, é a fonte principal; estes servem de reserva). */
export const MODELOS_SUGERIDOS: Record<NomeProvedor, string[]> = {
  anthropic: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"],
  openai: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini"],
};

/** Modelo usado quando a conta não escolheu nenhum. */
export const MODELO_INICIAL: Record<NomeProvedor, string> = { anthropic: "claude-opus-5-5", openai: "gpt-4.1" };

/** Formato aceito para o ID de um modelo (digitado à mão ou vindo da lista). */
export const MODELO_VALIDO = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

export function chaveDoProvedor(p: NomeProvedor, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = (p === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY)?.trim();
  return v || undefined;
}

export interface ListaModelos {
  modelos: string[];
  /** "api" = lista ao vivo da conta; "sugeridos" = reserva (sem chave ou a API não respondeu). */
  fonte: "api" | "sugeridos";
  erro?: string;
}

/** Só modelos de conversa: tira embeddings, áudio, imagem, moderação etc. */
export function filtrarModelosOpenAI(ids: string[]): string[] {
  const serve = /^(gpt-|chatgpt-|o\d)/i;
  const nao = /(embedding|tts|whisper|dall-e|image|audio|realtime|transcribe|moderation|search|instruct|davinci|babbage|computer-use)/i;
  return [...new Set(ids.filter((id) => serve.test(id) && !nao.test(id)))].sort().reverse();
}

type Fetch = (url: string, init: any) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

/** Lista os modelos disponíveis para a chave do provedor; se falhar, devolve as sugestões e o motivo. */
export async function listarModelos(
  provedor: NomeProvedor,
  opcoes: { apiKey?: string; fetchImpl?: Fetch; listarAnthropic?: (apiKey: string) => Promise<string[]> } = {}
): Promise<ListaModelos> {
  const apiKey = opcoes.apiKey ?? chaveDoProvedor(provedor);
  const sugeridos = (erro?: string): ListaModelos => ({ modelos: MODELOS_SUGERIDOS[provedor], fonte: "sugeridos", ...(erro ? { erro } : {}) });
  if (!apiKey) return sugeridos("A chave deste provedor ainda não foi configurada no servidor.");
  try {
    if (provedor === "openai") {
      const f: Fetch = opcoes.fetchImpl ?? ((u, i) => fetch(u, i) as any);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 15_000);
      try {
        const r = await f("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${apiKey}` }, signal: ctl.signal });
        if (!r.ok) return sugeridos(r.status === 401 || r.status === 403 ? "A chave da OpenAI foi recusada." : `A OpenAI respondeu ${r.status}.`);
        const ids = filtrarModelosOpenAI(((await r.json())?.data ?? []).map((m: any) => String(m?.id ?? "")));
        return ids.length > 0 ? { modelos: ids, fonte: "api" } : sugeridos("A conta não listou nenhum modelo de conversa.");
      } finally {
        clearTimeout(timer);
      }
    }
    const ids = opcoes.listarAnthropic
      ? await opcoes.listarAnthropic(apiKey)
      : (await new Anthropic({ apiKey, maxRetries: 0, timeout: 15_000 }).models.list({ limit: 100 })).data.map((m) => m.id);
    const claude = ids.filter((id) => /^claude-/.test(id));
    return claude.length > 0 ? { modelos: claude, fonte: "api" } : sugeridos("A conta não listou nenhum modelo.");
  } catch (e: any) {
    const status = e?.status;
    return sugeridos(status === 401 || status === 403 ? "A chave foi recusada." : "Não foi possível consultar a lista agora.");
  }
}

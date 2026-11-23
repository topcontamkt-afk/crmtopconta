import Anthropic from "@anthropic-ai/sdk";
import { ChamadaModelo, ErroProvedor, MotivoParada, PedidoModelo, ProvedorIA, RespostaModelo, Turno } from "./tipos";

/**
 * Provedor Anthropic (Claude), SDK oficial na API beta. Esforço médio, cache de prompt e `fallbacks` do servidor nos modelos
 * que o suportam; histórico só anexado, com a resposta ORIGINAL do modelo (inclusive blocos de raciocínio) reenviada intacta.
 */

const MAX_TOKENS_RESPOSTA = 8000;
/** Modelos com `fallbacks` do lado do servidor (recusa por classificador de segurança cai num modelo de reserva). */
const COM_FALLBACK = /^claude-(opus-5|sonnet-5-5|fable|mythos)/;

/** O mínimo do cliente da Anthropic que o adaptador usa (permite trocar por um falso nos testes). */
export interface ClienteAnthropic {
  beta: { messages: { create(params: any): Promise<any> } };
}

function turnosParaMensagens(turnos: Turno[]): any[] {
  return turnos.map((t) => {
    if (t.tipo === "usuario") return { role: "user", content: t.texto };
    if (t.tipo === "assistente") {
      return {
        role: "assistant",
        // a resposta original do modelo vai de volta sem edição (blocos de raciocínio preservados)
        content: t.bruto ?? [
          ...(t.texto ? [{ type: "text", text: t.texto }] : []),
          ...t.chamadas.map((c) => ({ type: "tool_use", id: c.id, name: c.nome, input: c.entrada })),
        ],
      };
    }
    // todos os resultados de um mesmo turno vão numa ÚNICA mensagem
    return { role: "user", content: t.itens.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.conteudo, is_error: r.erro })) };
  });
}

export function parametrosAnthropic(p: PedidoModelo, simples: boolean): Record<string, unknown> {
  return {
    model: p.modelo,
    max_tokens: MAX_TOKENS_RESPOSTA,
    // Sem `thinking`: nos modelos atuais o raciocínio adaptativo já vem ligado. Sem temperature/top_p (removidos).
    ...(simples ? {} : { output_config: { effort: "medium" }, cache_control: { type: "ephemeral" } }),
    system: p.sistema,
    tools: p.ferramentas.map((f) => ({ name: f.nome, description: f.descricao, input_schema: f.esquema })),
    ...(p.ultimoPasso ? { tool_choice: { type: "none" } } : {}),
    messages: turnosParaMensagens(p.turnos),
    ...(!simples && COM_FALLBACK.test(p.modelo) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
  };
}

/** Traduz os erros do SDK para o erro neutro (por status, sem depender das classes do SDK). */
function traduzir(e: any): ErroProvedor {
  if (e instanceof ErroProvedor) return e;
  const status: number | undefined = e?.status;
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new ErroProvedor("TEMPO_ESGOTADO", "tempo esgotado");
  if (status === 401 || status === 403) return new ErroProvedor("CHAVE_RECUSADA", "chave recusada", status);
  if (status === 429) return new ErroProvedor("LIMITE_PROVEDOR", "limite do provedor", status);
  if (status === 404) return new ErroProvedor("MODELO_INVALIDO", String(e?.message ?? "modelo não encontrado").slice(0, 200), status);
  return new ErroProvedor("FALHA_PROVEDOR", String(e?.message ?? e).slice(0, 200), status);
}

export function criarProvedorAnthropic(cliente: ClienteAnthropic): ProvedorIA {
  // Se a API recusar (400) os recursos opcionais, repete uma vez sem eles e segue assim até o fim da conversa.
  let simples = false;
  return {
    nome: "anthropic",
    async responder(p: PedidoModelo): Promise<RespostaModelo> {
      let resp: any;
      try {
        try {
          resp = await cliente.beta.messages.create(parametrosAnthropic(p, simples));
        } catch (e: any) {
          if (simples || e?.status !== 400) throw e;
          simples = true;
          console.warn("[assistente] a API recusou parâmetros opcionais; repetindo sem eles:", String(e?.message ?? e).slice(0, 300));
          resp = await cliente.beta.messages.create(parametrosAnthropic(p, true));
        }
      } catch (e) {
        throw traduzir(e);
      }
      const content: any[] = Array.isArray(resp.content) ? resp.content : [];
      const chamadas: ChamadaModelo[] = content.filter((b) => b?.type === "tool_use").map((b) => ({ id: b.id, nome: b.name, entrada: b.input }));
      const texto = content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n").trim();
      const parou: MotivoParada =
        resp.stop_reason === "refusal" ? "recusa" : resp.stop_reason === "tool_use" ? "ferramentas" : resp.stop_reason === "max_tokens" ? "truncada" : "fim";
      return {
        texto,
        chamadas,
        parou,
        bruto: content,
        uso: { entrada: resp.usage?.input_tokens ?? 0, saida: resp.usage?.output_tokens ?? 0, cacheLeitura: resp.usage?.cache_read_input_tokens ?? 0 },
      };
    },
  };
}

export function criarClienteAnthropic(apiKey: string): ClienteAnthropic {
  return new Anthropic({ apiKey, maxRetries: 1, timeout: 50_000 }) as unknown as ClienteAnthropic;
}

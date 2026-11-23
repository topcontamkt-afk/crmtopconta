import { INSTRUCOES_ASSISTENTE } from "./instrucoes";
import { ContextoFerramenta, executarFerramenta, FERRAMENTAS } from "./ferramentas";

/**
 * Laço do assistente: pergunta -> o modelo escolhe ferramentas de leitura -> o servidor as executa no tenant de quem
 * perguntou -> o modelo responde com o que voltou. O histórico é só ANEXADO (nunca editado) entre as chamadas, como a
 * API exige para blocos de raciocínio preservados. Nenhuma ferramenta escreve, envia ou projeta (ver ferramentas.ts).
 */

export const MODELO_PADRAO = "claude-opus-5-5";
export const MAX_PASSOS = 6;
const MAX_TOKENS_RESPOSTA = 8000;

export interface MensagemEntrada {
  role: "user" | "assistant";
  content: string;
}

export interface ChamadaFerramenta {
  nome: string;
  entrada: unknown;
  ok: boolean;
}

export type FimDaResposta = "completo" | "limite_de_passos" | "recusa" | "truncada";

export interface RespostaAssistente {
  resposta: string;
  ferramentas: ChamadaFerramenta[];
  uso: { entrada: number; saida: number; cacheLeitura: number };
  modelo: string;
  fim: FimDaResposta;
  avisos: string[];
}

/** O mínimo do cliente da Anthropic que o laço usa (permite trocar por um falso nos testes). */
export interface ClienteIA {
  beta: { messages: { create(params: any): Promise<any> } };
}

/** Modelos com `fallbacks` do lado do servidor (recusa por classificador de segurança cai num modelo de reserva). */
const COM_FALLBACK = /^claude-(opus-5|sonnet-5-5|fable|mythos)/;

export function parametrosDaChamada(modelo: string, messages: unknown[], ultimoPasso: boolean): Record<string, unknown> {
  return {
    model: modelo,
    max_tokens: MAX_TOKENS_RESPOSTA,
    // Sem `thinking`: nos modelos atuais o raciocínio adaptativo já vem ligado. Sem temperature/top_p (removidos).
    output_config: { effort: "medium" },
    cache_control: { type: "ephemeral" },
    system: INSTRUCOES_ASSISTENTE,
    tools: FERRAMENTAS.map((f) => ({ name: f.nome, description: f.descricao, input_schema: f.inputSchema })),
    // No último passo permitido, sem ferramentas: o modelo tem de responder com o que já reuniu.
    ...(ultimoPasso ? { tool_choice: { type: "none" } } : {}),
    messages,
    ...(COM_FALLBACK.test(modelo) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
  };
}

const textoDe = (content: any[]): string =>
  content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();

export async function responder(params: {
  mensagens: MensagemEntrada[];
  ctx: ContextoFerramenta;
  cliente: ClienteIA;
  modelo?: string;
}): Promise<RespostaAssistente> {
  const { ctx, cliente } = params;
  const modelo = params.modelo || MODELO_PADRAO;
  const messages: any[] = params.mensagens.map((m) => ({ role: m.role, content: m.content }));
  const chamadas: ChamadaFerramenta[] = [];
  const uso = { entrada: 0, saida: 0, cacheLeitura: 0 };
  const avisos: string[] = [];

  const montar = (resposta: string, fim: FimDaResposta): RespostaAssistente => {
    const falhas = chamadas.filter((c) => !c.ok).length;
    if (falhas > 0) avisos.push(`${falhas} consulta(s) não puderam ser feitas; a resposta pode estar incompleta.`);
    if (fim === "truncada") avisos.push("A resposta foi cortada por tamanho. Peça um recorte menor.");
    if (fim === "limite_de_passos") avisos.push("Foram necessárias muitas consultas; a resposta usa só o que foi reunido até aqui.");
    return { resposta, ferramentas: chamadas, uso, modelo, fim, avisos };
  };

  for (let passo = 0; passo < MAX_PASSOS; passo++) {
    const ultimo = passo === MAX_PASSOS - 1;
    const resp = await cliente.beta.messages.create(parametrosDaChamada(modelo, messages, ultimo));
    uso.entrada += resp.usage?.input_tokens ?? 0;
    uso.saida += resp.usage?.output_tokens ?? 0;
    uso.cacheLeitura += resp.usage?.cache_read_input_tokens ?? 0;

    if (resp.stop_reason === "refusal") {
      return montar("Não posso responder a este pedido.", "recusa");
    }

    // Anexa a resposta INTEIRA (inclusive blocos de raciocínio): o histórico nunca é editado.
    messages.push({ role: "assistant", content: resp.content });

    if (resp.stop_reason !== "tool_use") {
      const texto = textoDe(resp.content);
      const fim: FimDaResposta = resp.stop_reason === "max_tokens" ? "truncada" : ultimo && chamadas.length > 0 && !texto ? "limite_de_passos" : "completo";
      return montar(texto || "Não consegui montar uma resposta com os dados disponíveis.", fim);
    }

    const pedidos = (resp.content as any[]).filter((b) => b?.type === "tool_use");
    const resultados = await Promise.all(pedidos.map((b) => executarFerramenta(b.name, b.input, ctx)));
    pedidos.forEach((b, i) => chamadas.push({ nome: b.name, entrada: b.input, ok: resultados[i].ok }));
    messages.push({
      role: "user",
      // Todos os resultados de um mesmo turno vão numa ÚNICA mensagem.
      content: pedidos.map((b, i) => ({ type: "tool_result", tool_use_id: b.id, content: resultados[i].conteudo, is_error: !resultados[i].ok })),
    });
  }

  return montar("Não consegui concluir a consulta. Tente uma pergunta mais específica.", "limite_de_passos");
}

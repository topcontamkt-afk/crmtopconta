import { PedidoModelo, ProvedorIA, RespostaModelo, ErroProvedor, erroPorStatus, ChamadaModelo, MotivoParada } from "./tipos";

/**
 * Provedor OpenAI (GPT) pela API Chat Completions, com `fetch` (funciona igual na Vercel e no Worker da Cloudflare, sem
 * dependência extra). Chamada de ferramentas no formato `tools`/`tool_calls`. Sem temperatura nem parâmetros de raciocínio:
 * valem para qualquer modelo de chat da conta.
 */

const URL_BASE = "https://api.openai.com/v1";
const MAX_TOKENS_RESPOSTA = 8000;
const TIMEOUT_MS = 50_000;

type Fetch = (url: string, init: any) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export function criarProvedorOpenAI(opcoes: { apiKey: string; fetchImpl?: Fetch }): ProvedorIA {
  const fetchImpl: Fetch = opcoes.fetchImpl ?? ((url, init) => fetch(url, init) as any);
  // plano B: alguns modelos mais antigos só aceitam `max_tokens` em vez de `max_completion_tokens`
  let tokensLegado = false;

  const montarMensagens = (p: PedidoModelo): unknown[] => {
    const msgs: any[] = [{ role: "system", content: p.sistema }];
    for (const t of p.turnos) {
      if (t.tipo === "usuario") msgs.push({ role: "user", content: t.texto });
      else if (t.tipo === "assistente") {
        msgs.push({
          role: "assistant",
          content: t.texto || null,
          ...(t.chamadas.length > 0
            ? { tool_calls: t.chamadas.map((c) => ({ id: c.id, type: "function", function: { name: c.nome, arguments: JSON.stringify(c.entrada ?? {}) } })) }
            : {}),
        });
      } else {
        for (const r of t.itens) msgs.push({ role: "tool", tool_call_id: r.id, content: r.conteudo });
      }
    }
    return msgs;
  };

  const chamar = async (corpo: Record<string, unknown>) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      return await fetchImpl(`${URL_BASE}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opcoes.apiKey}` },
        body: JSON.stringify(corpo),
        signal: ctl.signal,
      });
    } catch (e: any) {
      if (e?.name === "AbortError") throw new ErroProvedor("TEMPO_ESGOTADO", "tempo esgotado");
      throw new ErroProvedor("FALHA_PROVEDOR", `falha de rede: ${String(e?.message ?? e).slice(0, 200)}`);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    nome: "openai",
    async responder(p: PedidoModelo): Promise<RespostaModelo> {
      const corpo = (legado: boolean): Record<string, unknown> => ({
        model: p.modelo,
        messages: montarMensagens(p),
        ...(p.ferramentas.length > 0
          ? {
              tools: p.ferramentas.map((f) => ({ type: "function", function: { name: f.nome, description: f.descricao, parameters: f.esquema } })),
              ...(p.ultimoPasso ? { tool_choice: "none" } : {}),
            }
          : {}),
        ...(legado ? { max_tokens: MAX_TOKENS_RESPOSTA } : { max_completion_tokens: MAX_TOKENS_RESPOSTA }),
      });

      let resp = await chamar(corpo(tokensLegado));
      let texto = await resp.text();
      if (!resp.ok && resp.status === 400 && !tokensLegado && /max_completion_tokens/i.test(texto)) {
        tokensLegado = true;
        console.warn("[assistente] o modelo recusou max_completion_tokens; repetindo com max_tokens");
        resp = await chamar(corpo(true));
        texto = await resp.text();
      }
      if (!resp.ok) {
        let detalhe = texto.slice(0, 300);
        try {
          detalhe = JSON.parse(texto)?.error?.message ?? detalhe;
        } catch {
          /* texto simples */
        }
        throw erroPorStatus(resp.status, String(detalhe).slice(0, 300));
      }

      let json: any;
      try {
        json = JSON.parse(texto);
      } catch {
        throw new ErroProvedor("FALHA_PROVEDOR", "resposta da OpenAI não é JSON");
      }
      const escolha = json?.choices?.[0];
      const msg = escolha?.message ?? {};
      const chamadas: ChamadaModelo[] = (Array.isArray(msg.tool_calls) ? msg.tool_calls : [])
        .filter((c: any) => c?.type === "function" || c?.function)
        .map((c: any) => {
          let entrada: unknown = {};
          try {
            entrada = JSON.parse(c.function?.arguments || "{}");
          } catch {
            entrada = { __argumentos_invalidos: true }; // o zod da ferramenta recusa e o modelo corrige
          }
          return { id: String(c.id), nome: String(c.function?.name ?? ""), entrada };
        });

      let parou: MotivoParada = "fim";
      if (msg.refusal || escolha?.finish_reason === "content_filter") parou = "recusa";
      else if (chamadas.length > 0) parou = "ferramentas";
      else if (escolha?.finish_reason === "length") parou = "truncada";

      return {
        texto: typeof msg.content === "string" ? msg.content.trim() : "",
        chamadas,
        parou,
        uso: {
          entrada: json?.usage?.prompt_tokens ?? 0,
          saida: json?.usage?.completion_tokens ?? 0,
          cacheLeitura: json?.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        },
      };
    },
  };
}

import { criarProvedorOpenAI } from "./openai";
import { ErroProvedor, PedidoModelo } from "./tipos";

const pedido = (extra: Partial<PedidoModelo> = {}): PedidoModelo => ({
  modelo: "gpt-4.1",
  sistema: "SISTEMA",
  ferramentas: [{ nome: "resumo_base", descricao: "d", esquema: { type: "object", properties: { cidade: { type: "string" } }, required: [], additionalProperties: false } }],
  turnos: [{ tipo: "usuario", texto: "oi" }],
  ultimoPasso: false,
  ...extra,
});

type Resp = { ok: boolean; status: number; corpo: unknown };
function fetchFalso(respostas: Resp[]) {
  const chamadas: { url: string; init: any; corpo: any }[] = [];
  const fetchImpl = jest.fn(async (url: string, init: any) => {
    chamadas.push({ url, init, corpo: JSON.parse(init.body) });
    const r = respostas.shift();
    if (!r) throw new Error("sem resposta simulada");
    return { ok: r.ok, status: r.status, text: async () => (typeof r.corpo === "string" ? r.corpo : JSON.stringify(r.corpo)) };
  });
  return { fetchImpl, chamadas };
}
const ok = (message: object, finish = "stop", usage: object = { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } }): Resp => ({
  ok: true, status: 200, corpo: { choices: [{ message, finish_reason: finish }], usage },
});

describe("criarProvedorOpenAI", () => {
  it("monta a chamada: chave no cabeçalho, sistema, ferramentas no formato function e limite de tokens", async () => {
    const { fetchImpl, chamadas } = fetchFalso([ok({ role: "assistant", content: "Olá" })]);
    await criarProvedorOpenAI({ apiKey: "sk-teste", fetchImpl }).responder(pedido());
    const c = chamadas[0];
    expect(c.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(c.init.headers.authorization).toBe("Bearer sk-teste");
    expect(c.corpo).toMatchObject({ model: "gpt-4.1", max_completion_tokens: 8000 });
    expect(c.corpo.messages).toEqual([{ role: "system", content: "SISTEMA" }, { role: "user", content: "oi" }]);
    expect(c.corpo.tools).toEqual([{ type: "function", function: { name: "resumo_base", description: "d", parameters: expect.any(Object) } }]);
    for (const k of ["temperature", "tool_choice", "max_tokens"]) expect(c.corpo).not.toHaveProperty(k);
  });

  it("lê texto e uso; resposta final vira 'fim'", async () => {
    const { fetchImpl } = fetchFalso([ok({ role: "assistant", content: "  Há 42 clientes.  " })]);
    const r = await criarProvedorOpenAI({ apiKey: "k", fetchImpl }).responder(pedido());
    expect(r).toMatchObject({ texto: "Há 42 clientes.", parou: "fim", chamadas: [], uso: { entrada: 100, saida: 20, cacheLeitura: 40 } });
  });

  it("tool_calls viram chamadas com os argumentos já lidos", async () => {
    const { fetchImpl } = fetchFalso([
      ok({ role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "resumo_base", arguments: '{"cidade":"Natal"}' } }] }, "tool_calls"),
    ]);
    const r = await criarProvedorOpenAI({ apiKey: "k", fetchImpl }).responder(pedido());
    expect(r.parou).toBe("ferramentas");
    expect(r.chamadas).toEqual([{ id: "call_1", nome: "resumo_base", entrada: { cidade: "Natal" } }]);
  });

  it("argumentos que não são JSON viram marca de erro (a validação da ferramenta recusa)", async () => {
    const { fetchImpl } = fetchFalso([ok({ role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "resumo_base", arguments: "{cidade:" } }] }, "tool_calls")]);
    const r = await criarProvedorOpenAI({ apiKey: "k", fetchImpl }).responder(pedido());
    expect(r.chamadas[0].entrada).toEqual({ __argumentos_invalidos: true });
  });

  it("traduz a conversa: assistente com tool_calls e cada resultado como mensagem 'tool'", async () => {
    const { fetchImpl, chamadas } = fetchFalso([ok({ role: "assistant", content: "ok" })]);
    await criarProvedorOpenAI({ apiKey: "k", fetchImpl }).responder(
      pedido({
        turnos: [
          { tipo: "usuario", texto: "oi" },
          { tipo: "assistente", texto: "", chamadas: [{ id: "a", nome: "resumo_base", entrada: { cidade: "Natal" } }, { id: "b", nome: "fontes_de_dados", entrada: {} }] },
          { tipo: "resultados", itens: [{ id: "a", conteudo: '{"x":1}', erro: false }, { id: "b", conteudo: "falhou", erro: true }] },
        ],
      })
    );
    const m = chamadas[0].corpo.messages;
    expect(m[2]).toEqual({
      role: "assistant", content: null,
      tool_calls: [
        { id: "a", type: "function", function: { name: "resumo_base", arguments: '{"cidade":"Natal"}' } },
        { id: "b", type: "function", function: { name: "fontes_de_dados", arguments: "{}" } },
      ],
    });
    expect(m[3]).toEqual({ role: "tool", tool_call_id: "a", content: '{"x":1}' });
    expect(m[4]).toEqual({ role: "tool", tool_call_id: "b", content: "falhou" });
  });

  it("no último passo manda tool_choice none", async () => {
    const { fetchImpl, chamadas } = fetchFalso([ok({ role: "assistant", content: "fim" })]);
    await criarProvedorOpenAI({ apiKey: "k", fetchImpl }).responder(pedido({ ultimoPasso: true }));
    expect(chamadas[0].corpo.tool_choice).toBe("none");
  });

  it("recusa, filtro de conteúdo e corte por tamanho viram o motivo certo", async () => {
    const { fetchImpl } = fetchFalso([
      ok({ role: "assistant", content: null, refusal: "não posso" }),
      ok({ role: "assistant", content: "" }, "content_filter"),
      ok({ role: "assistant", content: "parcial" }, "length"),
    ]);
    const prov = criarProvedorOpenAI({ apiKey: "k", fetchImpl });
    expect((await prov.responder(pedido())).parou).toBe("recusa");
    expect((await prov.responder(pedido())).parou).toBe("recusa");
    expect((await prov.responder(pedido())).parou).toBe("truncada");
  });

  it("modelo que só aceita max_tokens: repete uma vez e lembra", async () => {
    const { fetchImpl, chamadas } = fetchFalso([
      { ok: false, status: 400, corpo: { error: { message: "Unsupported parameter: 'max_completion_tokens' is not supported with this model." } } },
      ok({ role: "assistant", content: "a" }),
      ok({ role: "assistant", content: "b" }),
    ]);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const prov = criarProvedorOpenAI({ apiKey: "k", fetchImpl });
    await prov.responder(pedido());
    await prov.responder(pedido());
    expect(chamadas[0].corpo).toHaveProperty("max_completion_tokens");
    expect(chamadas[1].corpo).toHaveProperty("max_tokens");
    expect(chamadas[1].corpo).not.toHaveProperty("max_completion_tokens");
    expect(chamadas[2].corpo).toHaveProperty("max_tokens"); // lembra nas chamadas seguintes
  });

  it.each([
    [401, "CHAVE_RECUSADA"],
    [403, "CHAVE_RECUSADA"],
    [429, "LIMITE_PROVEDOR"],
    [404, "MODELO_INVALIDO"],
    [500, "FALHA_PROVEDOR"],
  ])("status %s vira o erro neutro %s, sem vazar a chave", async (status, codigo) => {
    const { fetchImpl } = fetchFalso([{ ok: false, status, corpo: { error: { message: "Incorrect API key provided: sk-proj-abc" } } }]);
    const e = await criarProvedorOpenAI({ apiKey: "sk-proj-abc", fetchImpl }).responder(pedido()).catch((x) => x);
    expect(e).toBeInstanceOf(ErroProvedor);
    expect(e.codigo).toBe(codigo);
  });

  it("falha de rede e tempo esgotado viram erros neutros", async () => {
    const rede = jest.fn().mockRejectedValue(new Error("ECONNRESET"));
    expect(await criarProvedorOpenAI({ apiKey: "k", fetchImpl: rede }).responder(pedido()).catch((x) => x)).toMatchObject({ codigo: "FALHA_PROVEDOR" });
    const tempo = jest.fn().mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));
    expect(await criarProvedorOpenAI({ apiKey: "k", fetchImpl: tempo }).responder(pedido()).catch((x) => x)).toMatchObject({ codigo: "TEMPO_ESGOTADO" });
  });

  it("resposta que não é JSON vira falha do provedor", async () => {
    const { fetchImpl } = fetchFalso([{ ok: true, status: 200, corpo: "<html>erro</html>" }]);
    expect(await criarProvedorOpenAI({ apiKey: "k", fetchImpl }).responder(pedido()).catch((x) => x)).toMatchObject({ codigo: "FALHA_PROVEDOR" });
  });
});

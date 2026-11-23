import { criarProvedorAnthropic, parametrosAnthropic } from "./anthropic";
import { ErroProvedor, PedidoModelo } from "./tipos";

const pedido = (extra: Partial<PedidoModelo> = {}): PedidoModelo => ({
  modelo: "claude-opus-5-5",
  sistema: "SISTEMA",
  ferramentas: [{ nome: "resumo_base", descricao: "d", esquema: { type: "object", properties: {}, required: [], additionalProperties: false } }],
  turnos: [{ tipo: "usuario", texto: "oi" }],
  ultimoPasso: false,
  ...extra,
});
const texto = (t: string) => ({ stop_reason: "end_turn", content: [{ type: "text", text: t }], usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 } });

function clienteFalso(respostas: Array<object | Error>) {
  const chamadas: any[] = [];
  const create = jest.fn(async (params: any) => {
    chamadas.push(JSON.parse(JSON.stringify(params)));
    const r = respostas.shift();
    if (r instanceof Error) throw r;
    if (!r) throw new Error("sem resposta simulada");
    return r;
  });
  return { cliente: { beta: { messages: { create } } }, chamadas, create };
}

describe("parametrosAnthropic", () => {
  it("modelo atual: esforço médio, cache, ferramentas e fallback; sem temperatura nem raciocínio forçado", () => {
    const p: any = parametrosAnthropic(pedido(), false);
    expect(p).toMatchObject({ model: "claude-opus-5-5", system: "SISTEMA", output_config: { effort: "medium" }, cache_control: { type: "ephemeral" }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
    expect(p.tools).toEqual([{ name: "resumo_base", description: "d", input_schema: expect.any(Object) }]);
    for (const k of ["temperature", "thinking", "tool_choice"]) expect(p).not.toHaveProperty(k);
  });
  it("modelos sem fallback do servidor não recebem o parâmetro", () => {
    const p: any = parametrosAnthropic(pedido({ modelo: "claude-haiku-5-5" }), false);
    expect(p).not.toHaveProperty("fallbacks");
    expect(p).not.toHaveProperty("betas");
  });
  it("último passo proíbe novas ferramentas; versão simples tira os opcionais", () => {
    expect((parametrosAnthropic(pedido({ ultimoPasso: true }), false) as any).tool_choice).toEqual({ type: "none" });
    const s: any = parametrosAnthropic(pedido(), true);
    for (const k of ["cache_control", "output_config", "fallbacks", "betas"]) expect(s).not.toHaveProperty(k);
    expect(s.tools).toHaveLength(1);
  });
  it("traduz a conversa neutra: o bruto volta intacto e os resultados vão numa só mensagem", () => {
    const bruto = [{ type: "thinking", thinking: "", signature: "s" }, { type: "tool_use", id: "a", name: "resumo_base", input: {} }];
    const p: any = parametrosAnthropic(
      pedido({
        turnos: [
          { tipo: "usuario", texto: "oi" },
          { tipo: "assistente", texto: "", chamadas: [{ id: "a", nome: "resumo_base", entrada: {} }], bruto },
          { tipo: "resultados", itens: [{ id: "a", conteudo: "{}", erro: false }, { id: "b", conteudo: "falhou", erro: true }] },
        ],
      }),
      false
    );
    expect(p.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(p.messages[1].content).toEqual(bruto);
    expect(p.messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "a", content: "{}", is_error: false },
      { type: "tool_result", tool_use_id: "b", content: "falhou", is_error: true },
    ]);
  });
  it("sem bruto (turno vindo do cliente) monta os blocos a partir da conversa neutra", () => {
    const p: any = parametrosAnthropic(pedido({ turnos: [{ tipo: "assistente", texto: "olá", chamadas: [] }] }), false);
    expect(p.messages[0]).toEqual({ role: "assistant", content: [{ type: "text", text: "olá" }] });
  });
});

describe("criarProvedorAnthropic", () => {
  it("lê texto, ferramentas, motivo de parada e uso", async () => {
    const { cliente } = clienteFalso([
      { stop_reason: "tool_use", content: [{ type: "text", text: "vou consultar" }, { type: "tool_use", id: "t1", name: "resumo_base", input: { cidade: "Natal" } }], usage: { input_tokens: 5, output_tokens: 2 } },
      texto("pronto"),
    ]);
    const prov = criarProvedorAnthropic(cliente);
    const a = await prov.responder(pedido());
    expect(a).toMatchObject({ parou: "ferramentas", texto: "vou consultar", chamadas: [{ id: "t1", nome: "resumo_base", entrada: { cidade: "Natal" } }] });
    expect(a.bruto).toHaveLength(2);
    const b = await prov.responder(pedido());
    expect(b).toMatchObject({ parou: "fim", texto: "pronto", uso: { entrada: 100, saida: 20, cacheLeitura: 50 } });
  });

  it("recusa e truncamento viram o motivo certo", async () => {
    const { cliente } = clienteFalso([{ stop_reason: "refusal", content: [], usage: {} }, { stop_reason: "max_tokens", content: [{ type: "text", text: "..." }], usage: {} }]);
    const prov = criarProvedorAnthropic(cliente);
    expect((await prov.responder(pedido())).parou).toBe("recusa");
    expect((await prov.responder(pedido())).parou).toBe("truncada");
  });

  it("400 na 1ª chamada: repete sem os opcionais e segue simples nas seguintes", async () => {
    const { cliente, chamadas } = clienteFalso([Object.assign(new Error("400 fallbacks: Extra inputs are not permitted"), { status: 400 }), texto("a"), texto("b")]);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const prov = criarProvedorAnthropic(cliente);
    await prov.responder(pedido());
    await prov.responder(pedido());
    expect(chamadas[0]).toHaveProperty("fallbacks");
    expect(chamadas[1]).not.toHaveProperty("fallbacks");
    expect(chamadas[2]).not.toHaveProperty("fallbacks");
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("se a versão simples também for recusada, vira erro neutro (sem laço)", async () => {
    const { cliente, create } = clienteFalso([Object.assign(new Error("400 a"), { status: 400 }), Object.assign(new Error("400 b"), { status: 400 })]);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(criarProvedorAnthropic(cliente).responder(pedido())).rejects.toMatchObject({ codigo: "FALHA_PROVEDOR", status: 400 });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it.each([
    [401, "CHAVE_RECUSADA"],
    [403, "CHAVE_RECUSADA"],
    [429, "LIMITE_PROVEDOR"],
    [404, "MODELO_INVALIDO"],
    [500, "FALHA_PROVEDOR"],
  ])("status %s vira o erro neutro %s, sem plano B", async (status, codigo) => {
    const { cliente, create } = clienteFalso([Object.assign(new Error("segredo sk-ant-xyz"), { status })]);
    const e = await criarProvedorAnthropic(cliente).responder(pedido()).catch((x) => x);
    expect(e).toBeInstanceOf(ErroProvedor);
    expect(e.codigo).toBe(codigo);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

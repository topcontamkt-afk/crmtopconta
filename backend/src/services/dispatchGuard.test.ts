import { erroDeInfra, orcamentoMs, ORCAMENTO_MS_PADRAO } from "./dispatchGuard";
import { bloqueioPorRestricao, restricaoDeEnvio } from "./envioRestrito";

describe("erroDeInfra", () => {
  it("reconhece limites da plataforma, não erro do contato", () => {
    expect(erroDeInfra("Não foi possível falar com a Meta: Too many subrequests by single Worker invocation.")).toBe(true);
    expect(erroDeInfra("Worker exceeded CPU time limit.")).toBe(true);
    expect(erroDeInfra("131049 This message was not delivered to maintain healthy ecosystem engagement.")).toBe(false);
    expect(erroDeInfra("131026 Message undeliverable")).toBe(false);
    expect(erroDeInfra(null)).toBe(false);
  });
});

describe("orcamentoMs", () => {
  it("usa o padrão e aceita ajuste por variável de ambiente", () => {
    expect(orcamentoMs({} as any)).toBe(ORCAMENTO_MS_PADRAO);
    expect(orcamentoMs({ DISPATCH_ORCAMENTO_MS: "5000" } as any)).toBe(5000);
    expect(orcamentoMs({ DISPATCH_ORCAMENTO_MS: "lixo" } as any)).toBe(ORCAMENTO_MS_PADRAO);
  });
});

describe("restrição de envio na homologação", () => {
  it("fora de homologação não restringe nada", () => {
    expect(bloqueioPorRestricao(restricaoDeEnvio({ APP_ENV: "prod" } as any), "+5579999998888")).toBeNull();
    expect(bloqueioPorRestricao(restricaoDeEnvio({} as any), "+5579999998888")).toBeNull();
  });
  it("em hml só passa número da lista, em qualquer forma (com ou sem nono dígito)", () => {
    const r = restricaoDeEnvio({ APP_ENV: "hml", ENVIO_PERMITIDO_PARA: "+55 79 99999-8888; 5584988887777" } as any);
    expect(bloqueioPorRestricao(r, "+5579999998888")).toBeNull();
    expect(bloqueioPorRestricao(r, "5579999998888")).toBeNull();
    expect(bloqueioPorRestricao(r, "+5584988887777")).toBeNull();
    expect(bloqueioPorRestricao(r, "+5579911112222")).toMatch(/lista de teste/);
    expect(bloqueioPorRestricao(r, null)).toMatch(/lista de teste/);
  });
  it("em hml o valor * libera qualquer número, e uma lista sem * continua restrita", () => {
    const liberado = restricaoDeEnvio({ APP_ENV: "hml", ENVIO_PERMITIDO_PARA: "*" } as any);
    expect(liberado.ativa).toBe(false);
    expect(bloqueioPorRestricao(liberado, "+5579911112222")).toBeNull();
    expect(restricaoDeEnvio({ APP_ENV: "hml", ENVIO_PERMITIDO_PARA: "5579999998888" } as any).ativa).toBe(true);
  });
  it("em hml com a lista vazia nada sai", () => {
    expect(bloqueioPorRestricao(restricaoDeEnvio({ APP_ENV: "hml" } as any), "+5579999998888")).toMatch(/lista de teste/);
  });
});

jest.mock("../config/db", () => ({ tenantRaw: { query: jest.fn(), execute: jest.fn() } }));

import { bandWhere, Buyer, commerceCohorts, OPORTUNIDADES, OPPORTUNITY_KEYS, suggestedMessage, USO_BANDAS } from "./opportunities";
import { CATEGORY_MESSAGES, MERCHANT_CATEGORY_KEYS, messageForCategories, MULTI_CATEGORY_MESSAGE } from "./merchantCategories";
import { TEMPLATE_VARIABLES, variablesIn } from "./templateVariables";

const allowed = new Set<string>(TEMPLATE_VARIABLES);
const unsupported = (text: string) => variablesIn(text).filter((v) => !allowed.has(v));

describe("mensagens sugeridas só usam variáveis que o envio suporta", () => {
  it("categorias de comércio", () => {
    for (const [cat, msg] of Object.entries(CATEGORY_MESSAGES)) expect({ cat, bad: unsupported(msg) }).toEqual({ cat, bad: [] });
    expect(unsupported(MULTI_CATEGORY_MESSAGE)).toEqual([]);
  });

  it("toda categoria tem mensagem", () => {
    expect(Object.keys(CATEGORY_MESSAGES).sort()).toEqual([...MERCHANT_CATEGORY_KEYS].sort());
  });

  it("faixas de uso e oportunidades", () => {
    for (const b of USO_BANDAS) expect({ k: b.key, bad: unsupported(b.mensagem) }).toEqual({ k: b.key, bad: [] });
    for (const o of OPORTUNIDADES) if (o.mensagem) expect({ k: o.key, bad: unsupported(o.mensagem) }).toEqual({ k: o.key, bad: [] });
  });
});

describe("oportunidades", () => {
  it("toda oportunidade de campanha tem chave aceita pela rota de audiência e mensagem", () => {
    for (const o of OPORTUNIDADES.filter((x) => x.status === "campanha")) {
      expect(OPPORTUNITY_KEYS).toContain(o.key);
      expect(suggestedMessage(o.key as any)).toBeTruthy();
    }
  });

  it("itens de dados/histórico não têm mensagem nem chave de audiência", () => {
    for (const o of OPORTUNIDADES.filter((x) => x.status !== "campanha")) expect(OPPORTUNITY_KEYS).not.toContain(o.key);
  });

  it("faixas cobrem 0%, 1-49, 50-69, 70-79, 80-99 e 100 sem sobreposição", () => {
    expect(USO_BANDAS.map((b) => b.range)).toEqual(["0%", "1 a 49%", "50 a 69%", "70 a 79%", "80 a 99%", "100%"]);
    expect(bandWhere("uso_1_49")).toEqual({ percentualUtilizado: { gt: 0, lt: 50 } });
    expect(bandWhere("uso_80_99")).toEqual({ percentualUtilizado: { gte: 80, lt: 100 } });
    expect(bandWhere("uso_100")).toEqual({ percentualUtilizado: { gte: 100 } });
    expect(bandWhere("inativos")).toBeNull();
  });
});

describe("commerceCohorts", () => {
  const b = (id: string, n: number, valor: number, sup = false, posto = false): Buyer => ({ id, n, valor, super: sup, posto });
  const buyers: Buyer[] = [
    b("a", 1, 10, true), b("b", 3, 500, true, true), b("c", 2, 30, true), b("d", 1, 20, false, true),
    b("e", 5, 900, true), b("f", 1, 5), b("g", 1, 6), b("h", 2, 7), b("i", 1, 8), b("j", 1, 9),
  ];
  const c = commerceCohorts(buyers);

  it("supermercado sem posto", () => expect(c.comercio_super_sem_posto.sort()).toEqual(["a", "c", "e"]));
  it("uma única compra", () => expect(c.comercio_1vez.sort()).toEqual(["a", "d", "f", "g", "i", "j"]));
  it("três ou mais compras", () => expect(c.comercio_3mais.sort()).toEqual(["b", "e"]));
  it("top 10% em valor (1 de 10 compradores)", () => expect(c.comercio_top10).toEqual(["e"]));
  it("sem compradores, tudo vazio", () => expect(commerceCohorts([]).comercio_top10).toEqual([]));
});

describe("messageForCategories", () => {
  it("uma categoria usa a específica; várias ou nenhuma válida usam a genérica", () => {
    expect(messageForCategories(["POSTO"])).toBe(CATEGORY_MESSAGES.POSTO);
    expect(messageForCategories(["POSTO", "FARMACIA"])).toBe(MULTI_CATEGORY_MESSAGE);
    expect(messageForCategories(["INVALIDA"])).toBe(MULTI_CATEGORY_MESSAGE);
  });
});

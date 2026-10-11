import { cidadeKey, cidadeKeySql, parseCidades, SEM_CIDADE } from "./cidades";

describe("cidadeKey — nome de empresa ou vazio vira 'Sem cidade'", () => {
  it.each(["TOP CONTA", "Top Conta", "MACHADO SERVICOS DE COBRANCA LTDA", "ARAUJO PROMOTORA", "Associação dos Servidores", "Empresa X EIRELI", "Posto 24h", "BSB BRASIL SMART BUSINESS"])(
    "%s não é cidade",
    (v) => expect(cidadeKey(v)).toBe(SEM_CIDADE)
  );
  it("vazio, nulo e só espaços também", () => {
    expect(cidadeKey("")).toBe(SEM_CIDADE);
    expect(cidadeKey("   ")).toBe(SEM_CIDADE);
    expect(cidadeKey(null)).toBe(SEM_CIDADE);
    expect(cidadeKey(undefined)).toBe(SEM_CIDADE);
  });
  it.each(["Natal", "Luziânia", "N. S. da Glória", "Itabaianinha", "Carmópolis", "Lagarto", "Boquim", "Itaporanga"])("%s é cidade", (v) => {
    expect(cidadeKey(v)).toBe(v.toLowerCase());
  });
  it("ignora caixa e espaços nas pontas na comparação", () => {
    expect(cidadeKey("  NATAL ")).toBe("natal");
  });
});

describe("parseCidades", () => {
  it("separa por |, tira espaços e reconhece o marcador de Sem cidade", () => {
    expect(parseCidades("natal| luziânia ")).toEqual(["natal", "luziânia"]);
    expect(parseCidades("natal|__sem_cidade__")).toEqual(["natal", SEM_CIDADE]);
    expect(parseCidades(undefined)).toEqual([]);
    expect(parseCidades("")).toEqual([]);
  });
});

describe("cidadeKeySql", () => {
  it("usa a coluna informada e as mesmas palavras da regra em JS", () => {
    const sql = cidadeKeySql('c."cidade"');
    expect(sql).toContain('c."cidade"');
    for (const w of ["ltda", "eireli", "promotora", "business", "top ?conta"]) expect(sql).toContain(w);
    expect(sql).toContain(SEM_CIDADE);
  });
});

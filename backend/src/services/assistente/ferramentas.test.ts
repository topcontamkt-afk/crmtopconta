jest.mock("../../config/db", () => ({ prisma: { client: { count: jest.fn(), groupBy: jest.fn() } }, tenantRaw: { query: jest.fn() } }));
jest.mock("../../routes/dashboard", () => ({ dadosCidadesDesempenho: jest.fn(), dadosHorarios: jest.fn(), dadosOportunidades: jest.fn() }));
jest.mock("../../routes/negocio", () => ({ dadosConvenios: jest.fn(), dadosFinanceiro: jest.fn(), dadosFontes: jest.fn() }));

import { prisma } from "../../config/db";
import { dadosCidadesDesempenho, dadosHorarios } from "../../routes/dashboard";
import { dadosFinanceiro } from "../../routes/negocio";
import { executarFerramenta, FERRAMENTAS, NOMES_FERRAMENTAS } from "./ferramentas";

const ctx = { tenantId: "t1", userId: "u1", role: "ADMIN" };

describe("catálogo de ferramentas", () => {
  it("só leitura, nomes únicos e esquema fechado", () => {
    expect(new Set(NOMES_FERRAMENTAS).size).toBe(FERRAMENTAS.length);
    for (const f of FERRAMENTAS) {
      expect(f.somenteLeitura).toBe(true);
      expect(f.inputSchema.type).toBe("object");
      expect(f.inputSchema.additionalProperties).toBe(false);
      expect(f.nome).toMatch(/^[a-z_]+$/);
      // nenhum verbo de escrita no nome
      expect(f.nome).not.toMatch(/criar|enviar|apagar|excluir|atualizar|gravar|disparar|importar/);
    }
  });

  it("nenhuma descrição nem esquema promete projeção, previsão ou estimativa", () => {
    const tudo = JSON.stringify(FERRAMENTAS.map((f) => ({ d: f.descricao, s: f.inputSchema })));
    expect(tudo).not.toMatch(/proje[cç]|previs|estimativ|potencial|risco de abandono|prov[aá]vel/i);
  });

  it("não existe ferramenta de risco, previsão ou ação", () => {
    expect(NOMES_FERRAMENTAS.some((n) => /risco|previs|proje|campanha_criar|enviar/.test(n))).toBe(false);
  });
});

describe("executarFerramenta", () => {
  beforeEach(() => jest.clearAllMocks());

  it("ferramenta desconhecida vira erro que lista as válidas", async () => {
    const r = await executarFerramenta("apagar_tudo", {}, ctx);
    expect(r.ok).toBe(false);
    expect(r.conteudo).toContain("resumo_base");
  });

  it("parâmetros inválidos voltam como erro para o modelo corrigir (nada é executado)", async () => {
    const r = await executarFerramenta("uso_por_hora", { dias: 5000, extra: 1 }, ctx);
    expect(r.ok).toBe(false);
    expect(r.conteudo).toMatch(/Parâmetros inválidos/);
    expect(dadosHorarios).not.toHaveBeenCalled();
  });

  it("respeita o acesso por área do usuário", async () => {
    const r = await executarFerramenta("financeiro_mes", {}, { ...ctx, podeUsar: (a) => a !== "dashboard" });
    expect(r.ok).toBe(false);
    expect(r.conteudo).toMatch(/perfil de acesso/);
    expect(dadosFinanceiro).not.toHaveBeenCalled();
  });

  it("financeiro: o resultado chega sem projeção, mesmo que a rota devolva", async () => {
    (dadosFinanceiro as jest.Mock).mockResolvedValue({ disponivel: true, atual: { lucro: 100 }, projecao: { lucro: { valor: 999 } } });
    const r = await executarFerramenta("financeiro_mes", {}, ctx);
    expect(r.ok).toBe(true);
    expect(r.conteudo).toContain('"lucro":100');
    expect(r.conteudo).not.toMatch(/proje|999/);
  });

  it("cidades: dados pessoais e classificações calculadas não passam", async () => {
    (dadosCidadesDesempenho as jest.Mock).mockResolvedValue({
      disponivel: true, ultimoDiaExtrato: "2026-10-15", extratoEmDia: false, diasDefasagem: 3, mediana: 50,
      cidades: [{ cidade: "Natal", clientes: 10, inativos: 1, usaramAtual: 5, usaramAnterior: 4, taxaUso: 50, taxaUsoAnterior: 40, variacaoPp: 10, situacao: "destaque", clientesEmJogo: 9, nome: "Maria" }],
      emDestaque: { cidade: "Natal" },
    });
    const r = await executarFerramenta("desempenho_cidades", {}, ctx);
    expect(r.conteudo).not.toMatch(/Maria|emJogo|emDestaque/);
    expect(r.conteudo).toContain("Natal");
  });

  it("contar_clientes: usa o tenant do login, conta e agrupa, e devolve o link da lista", async () => {
    (prisma.client.count as jest.Mock).mockResolvedValue(42);
    (prisma.client.groupBy as jest.Mock).mockResolvedValue([{ cidade: "Natal", _count: { _all: 30 } }, { cidade: null, _count: { _all: 12 } }]);
    const r = await executarFerramenta("contar_clientes", { cidade: ["Natal"], statusConta: ["INATIVO"], agruparPor: "cidade" }, ctx);
    expect(r.ok).toBe(true);
    const out = JSON.parse(r.conteudo);
    expect(out.total).toBe(42);
    expect(out.grupos).toEqual([{ valor: "Natal", clientes: 30 }, { valor: "(vazio)", clientes: 12 }]);
    expect(out.linkLista).toBe("/clients?cidade=Natal&statusConta=INATIVO");
    const where = ((prisma.client.count as jest.Mock).mock.calls[0][0] as any).where;
    expect(where.AND[0].tenantId).toBe("t1");
    expect(where.AND[1]).toEqual({ anonymizedAt: null }); // LGPD: anonimizados ficam fora de toda contagem
  });

  it("contar_clientes: filtro composto não gera link de lista", async () => {
    (prisma.client.count as jest.Mock).mockResolvedValue(3);
    const r = await executarFerramenta("contar_clientes", { cidade: ["Natal"], saldoDisponivelMin: 100 }, ctx);
    expect(JSON.parse(r.conteudo).linkLista).toBeNull();
  });

  it("o modelo não consegue escolher o tenant: entrada com tenantId é recusada", async () => {
    const r = await executarFerramenta("contar_clientes", { tenantId: "outro" }, ctx);
    expect(r.ok).toBe(false);
  });

  it("erro interno não vaza detalhes para o modelo", async () => {
    (prisma.client.count as jest.Mock).mockRejectedValue(new Error("connection string postgres://segredo"));
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await executarFerramenta("contar_clientes", {}, ctx);
    expect(r.ok).toBe(false);
    expect(r.conteudo).not.toMatch(/postgres|segredo/);
  });

  it("resultado enorme é cortado com aviso", async () => {
    (dadosHorarios as jest.Mock).mockResolvedValue({ disponivel: true, segmentos: [], total: { usos: 1, porHora: [], picoHora: 1 }, texto: "x".repeat(400), extras: Array.from({ length: 30 }, () => "y".repeat(450)) });
    const r = await executarFerramenta("uso_por_hora", {}, ctx);
    expect(r.ok).toBe(true);
    expect(r.conteudo.length).toBeLessThanOrEqual(24_100);
  });
});

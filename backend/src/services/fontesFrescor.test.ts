import { avaliarFonte, FonteEntrada } from "./fontesFrescor";

const agora = new Date("2026-11-23T12:00:00Z");
const diasAtras = (n: number) => new Date(agora.getTime() - n * 86_400_000);
const fonte = (p: Partial<FonteEntrada>): FonteEntrada => ({
  key: "x",
  label: "X",
  descricao: "d",
  ultima: diasAtras(0),
  atencaoDias: 7,
  desatualizadoDias: 14,
  acao: { label: "Importar", destino: "/imports" },
  ...p,
});

describe("avaliarFonte", () => {
  it("em dia: ok e sem ação", () => {
    expect(avaliarFonte(fonte({ ultima: diasAtras(2) }), agora)).toMatchObject({ status: "ok", dias: 2, acao: null });
  });
  it("passou do limite de atenção, depois do desatualizado, com ação", () => {
    expect(avaliarFonte(fonte({ ultima: diasAtras(8) }), agora)).toMatchObject({ status: "atencao", acao: { destino: "/imports" } });
    expect(avaliarFonte(fonte({ ultima: diasAtras(15) }), agora).status).toBe("desatualizado");
  });
  it("exatamente no limite ainda é ok (só passa quando ultrapassa)", () => {
    expect(avaliarFonte(fonte({ ultima: diasAtras(7) }), agora).status).toBe("ok");
    expect(avaliarFonte(fonte({ ultima: diasAtras(14) }), agora).status).toBe("atencao");
  });
  it("só limite de desatualizado (extrato: > 3 dias)", () => {
    const e = fonte({ atencaoDias: null, desatualizadoDias: 3 });
    expect(avaliarFonte({ ...e, ultima: diasAtras(3) }, agora).status).toBe("ok");
    expect(avaliarFonte({ ...e, ultima: diasAtras(4) }, agora).status).toBe("desatualizado");
  });
  it("sem data: 'sem dados' quando há limite, 'info' quando é só informativa", () => {
    expect(avaliarFonte(fonte({ ultima: null }), agora)).toMatchObject({ status: "sem_dados", dias: null });
    expect(avaliarFonte(fonte({ ultima: null, atencaoDias: null, desatualizadoDias: null }), agora).status).toBe("info");
  });
  it("fonte informativa nunca vira alerta, mesmo antiga", () => {
    const r = avaliarFonte(fonte({ ultima: diasAtras(90), atencaoDias: null, desatualizadoDias: null }), agora);
    expect(r).toMatchObject({ status: "info", acao: null });
  });
  it("data no futuro (relógio) não gera dias negativos", () => {
    expect(avaliarFonte(fonte({ ultima: new Date(agora.getTime() + 3_600_000) }), agora).dias).toBe(0);
  });
});

import { tendenciaDe } from "./oportunidadeTendencia";

const hoje = new Date("2026-11-23T00:00:00Z");
const dia = (n: number) => new Date(hoje.getTime() - n * 86_400_000);
const foto = (n: number, valores: Record<string, number>) => ({ day: dia(n), valores });

describe("tendenciaDe", () => {
  it("sem histórico anterior não há tendência (nada inventado)", () => {
    expect(tendenciaDe("inativos", 100, [], hoje)).toBeNull();
    expect(tendenciaDe("inativos", 100, [foto(0, { inativos: 90 })], hoje)).toBeNull(); // só hoje
  });

  it("ignora fotos fora da janela e fotos sem a chave", () => {
    expect(tendenciaDe("inativos", 100, [foto(45, { inativos: 50 })], hoje)).toBeNull();
    expect(tendenciaDe("inativos", 100, [foto(10, { semUso: 50 })], hoje)).toBeNull();
    expect(tendenciaDe("inativos", 100, [{ day: dia(10), valores: null }], hoje)).toBeNull();
  });

  it("usa a foto mais antiga da janela como referência", () => {
    const t = tendenciaDe("inativos", 120, [foto(5, { inativos: 110 }), foto(20, { inativos: 100 })], hoje);
    expect(t).toMatchObject({ dias: 20, anterior: 100, atual: 120, abs: 20, pct: 20 });
  });

  it("público de problema crescendo piora; encolhendo melhora", () => {
    expect(tendenciaDe("inativos", 130, [foto(30, { inativos: 100 })], hoje)).toMatchObject({ direcao: "subiu", efeito: "piora" });
    expect(tendenciaDe("inativos", 70, [foto(30, { inativos: 100 })], hoje)).toMatchObject({ direcao: "caiu", efeito: "melhora" });
  });

  it("público de potencial (comércio, uso alto) é neutro: mais volume, nem bom nem ruim", () => {
    expect(tendenciaDe("uso_71_99", 150, [foto(30, { uso_71_99: 100 })], hoje)?.efeito).toBe("neutro");
    expect(tendenciaDe("comercio_1vez", 50, [foto(30, { comercio_1vez: 100 })], hoje)?.efeito).toBe("neutro");
  });

  it("variação pequena (menos de 3% ou 5 clientes) é estável", () => {
    expect(tendenciaDe("inativos", 1010, [foto(30, { inativos: 1000 })], hoje)?.direcao).toBe("estavel"); // 1%
    expect(tendenciaDe("semUso", 14, [foto(30, { semUso: 10 })], hoje)?.direcao).toBe("estavel"); // 4 clientes
  });

  it("base anterior zero: sem percentual, descreve em clientes", () => {
    const t = tendenciaDe("inativos", 40, [foto(30, { inativos: 0 })], hoje);
    expect(t?.pct).toBeNull();
    expect(t?.leitura).toContain("40 clientes");
  });

  it("leitura própria entra depois do número", () => {
    const t = tendenciaDe("uso_71_99", 150, [foto(30, { uso_71_99: 100 })], hoje);
    expect(t?.leitura).toBe("Cresceu 50% em 30 dias. Mais clientes perto do limite: bom momento para oferta de aumento.");
  });
});

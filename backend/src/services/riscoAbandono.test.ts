import { EntradaRisco, intervaloNormal, nivelDe, pontuarRisco } from "./riscoAbandono";

const base: EntradaRisco = {
  limiteTotal: 1000,
  saldoDisponivel: 200,
  diasSemUso: 5,
  usosTotal: 20,
  usosUltimos90d: 6, // intervalo normal = 15 dias
  usos30: 2,
  usos60Anteriores: 4,
  diasDesdeAbertura: null,
  usouDesdeAbertura: true,
  enviadas90d: 0,
  respondeu90d: 0,
};
const e = (p: Partial<EntradaRisco>): EntradaRisco => ({ ...base, ...p });

describe("elegibilidade", () => {
  it("quem nunca usou, sem limite ou sem data de uso não é pontuado", () => {
    expect(pontuarRisco(e({ usosTotal: 0 }), true).elegivel).toBe(false);
    expect(pontuarRisco(e({ limiteTotal: 0 }), true).elegivel).toBe(false);
    expect(pontuarRisco(e({ diasSemUso: null }), true).elegivel).toBe(false);
  });
});

describe("intervaloNormal", () => {
  it("90 dias ÷ usos, limitado a 3–60; menos de 2 usos cai no padrão não medido", () => {
    expect(intervaloNormal(6)).toEqual({ dias: 15, medido: true });
    expect(intervaloNormal(90)).toEqual({ dias: 3, medido: true });
    expect(intervaloNormal(2)).toEqual({ dias: 45, medido: true });
    expect(intervaloNormal(1)).toEqual({ dias: 30, medido: false });
    expect(intervaloNormal(0).medido).toBe(false);
  });
});

describe("pontuarRisco", () => {
  it("cliente em dia com o próprio ritmo fica com nota baixa", () => {
    const r = pontuarRisco(e({ usos30: 2, usos60Anteriores: 4 }), true);
    expect(r).toMatchObject({ elegivel: true, nota: 0, nivel: "baixo" });
    expect(r.motivos).toHaveLength(0);
  });

  it("atraso de 3× o intervalo dá o peso cheio do atraso (35)", () => {
    const r = pontuarRisco(e({ diasSemUso: 45, usos30: 2, usos60Anteriores: 4, saldoDisponivel: 0 }), true);
    expect(r.motivos.find((m) => m.key === "atraso")?.pontos).toBe(35);
    expect(r.principal).toContain("3");
  });

  it("queda de frequência: parou de usar no último mês", () => {
    const r = pontuarRisco(e({ usos30: 0, usos60Anteriores: 4 }), true);
    expect(r.motivos.find((m) => m.key === "queda")?.pontos).toBe(25);
  });

  it("sem base anterior não há sinal de queda", () => {
    const r = pontuarRisco(e({ usos30: 0, usos60Anteriores: 0 }), true);
    expect(r.motivos.find((m) => m.key === "queda")).toBeUndefined();
  });

  it("saldo parado só conta quando já está atrasado", () => {
    const emDia = pontuarRisco(e({ diasSemUso: 5, saldoDisponivel: 1000 }), true);
    expect(emDia.motivos.find((m) => m.key === "saldo")).toBeUndefined();
    const atrasado = pontuarRisco(e({ diasSemUso: 40, saldoDisponivel: 1000 }), true);
    expect(atrasado.motivos.find((m) => m.key === "saldo")?.pontos).toBe(15);
  });

  it("ciclo aberto sem uso: metade do peso com 1–2 dias, cheio com 3+", () => {
    expect(pontuarRisco(e({ diasDesdeAbertura: 2, usouDesdeAbertura: false }), true).motivos.find((m) => m.key === "ciclo")?.pontos).toBe(7.5);
    expect(pontuarRisco(e({ diasDesdeAbertura: 5, usouDesdeAbertura: false }), true).motivos.find((m) => m.key === "ciclo")?.pontos).toBe(15);
    expect(pontuarRisco(e({ diasDesdeAbertura: 5, usouDesdeAbertura: true }), true).motivos.find((m) => m.key === "ciclo")).toBeUndefined();
    expect(pontuarRisco(e({ diasDesdeAbertura: null }), true).motivos.find((m) => m.key === "ciclo")).toBeUndefined();
  });

  it("campanhas: 2+ mensagens sem resposta pesa; uma só não", () => {
    expect(pontuarRisco(e({ enviadas90d: 3, respondeu90d: 0 }), true).motivos.find((m) => m.key === "campanhas")?.pontos).toBe(10);
    expect(pontuarRisco(e({ enviadas90d: 1, respondeu90d: 0 }), true).motivos.find((m) => m.key === "campanhas")).toBeUndefined();
    expect(pontuarRisco(e({ enviadas90d: 4, respondeu90d: 2 }), true).motivos.find((m) => m.key === "campanhas")).toBeUndefined();
  });

  it("todos os sinais juntos chegam a 100 e nível alto; motivos ordenados por peso", () => {
    const r = pontuarRisco(e({ diasSemUso: 60, usos30: 0, usos60Anteriores: 4, saldoDisponivel: 1000, diasDesdeAbertura: 6, usouDesdeAbertura: false, enviadas90d: 3, respondeu90d: 0 }), true);
    expect(r.nota).toBe(100);
    expect(r.nivel).toBe("alto");
    expect(r.motivos.map((m) => m.pontos)).toEqual([...r.motivos.map((m) => m.pontos)].sort((a, b) => b - a));
  });

  it("extrato parado rebaixa a confiança; poucos usos também", () => {
    expect(pontuarRisco(e({}), true).confianca).toBe("alta");
    expect(pontuarRisco(e({}), false).confianca).toBe("baixa");
    expect(pontuarRisco(e({ usosUltimos90d: 1 }), true).confianca).toBe("media");
  });
});

describe("nivelDe", () => {
  it("cortes 35 e 60", () => {
    expect([0, 34, 35, 59, 60, 100].map(nivelDe)).toEqual(["baixo", "baixo", "medio", "medio", "alto", "alto"]);
  });
});

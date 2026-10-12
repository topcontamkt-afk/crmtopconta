import { buildUsoPorDiaCiclo, breakdownByCiclo, diaDoCicloNoEnvio, faixaDoDiaCiclo, periodoAnalise } from "./cicloReport";

describe("buildUsoPorDiaCiclo", () => {
  // Cidade abre dia 15; período 10/10 a 25/10 (16 dias): dias do ciclo vistos: 26-31 (10 a 14/10 ≈ dias 26..30), 1..11
  const cidades = [{ cidadeKey: "luziânia", cidade: "Luziânia", diaAbertura: 15, clientes: 100 }];

  it("pico no dia 1-2 do ciclo é OK e o uso é normalizado por clientes e dias observados", () => {
    const uso = [
      { cidadeKey: "luziânia", data: "2026-10-15", usos: 30, antecipacoes: 25 },
      { cidadeKey: "luziânia", data: "2026-10-16", usos: 20, antecipacoes: 15 },
      { cidadeKey: "luziânia", data: "2026-10-20", usos: 5, antecipacoes: 4 },
    ];
    const r = buildUsoPorDiaCiclo({ cidades, uso, de: "2026-10-10", ate: "2026-10-25" });
    const c = r.find((x) => x.cidadeKey === "luziânia")!;
    expect(c.curva[0]).toMatchObject({ diaDoCiclo: 1, usos: 30, diasObservados: 1, usosPor100: 30 }); // 30 usos / (100 clientes × 1 dia)
    expect(c.picoDiaDoCiclo).toBe(1);
    expect(c.diagnostico).toBe("OK");
    expect(r[0].cidadeKey).toBeNull(); // "todas" vem primeiro
    expect(r[0].usos).toBe(55);
  });

  it("pico longe da abertura pede revisão da data cadastrada", () => {
    const uso = [
      { cidadeKey: "luziânia", data: "2026-10-15", usos: 5, antecipacoes: 0 },
      { cidadeKey: "luziânia", data: "2026-10-20", usos: 40, antecipacoes: 30 }, // dia 6 do ciclo
    ];
    const c = buildUsoPorDiaCiclo({ cidades, uso, de: "2026-10-10", ate: "2026-10-25" }).find((x) => x.cidadeKey === "luziânia")!;
    expect(c.picoDiaDoCiclo).toBe(6);
    expect(c.diagnostico).toBe("REVISAR");
  });

  it("poucos usos: sem diagnóstico", () => {
    const r = buildUsoPorDiaCiclo({ cidades, uso: [{ cidadeKey: "luziânia", data: "2026-10-15", usos: 3, antecipacoes: 3 }], de: "2026-10-10", ate: "2026-10-25" });
    expect(r[1].diagnostico).toBe("POUCOS_DADOS");
  });
});

describe("periodoAnalise", () => {
  it("termina no último dia do extrato e não começa antes do primeiro", () => {
    expect(periodoAnalise("2026-09-09", "2026-10-09", 90)).toEqual({ de: "2026-09-09", ate: "2026-10-09" });
    expect(periodoAnalise("2026-01-01", "2026-10-09", 30)).toEqual({ de: "2026-09-10", ate: "2026-10-09" });
    expect(periodoAnalise(null, null, 30)).toBeNull();
  });
});

describe("dia do ciclo no envio", () => {
  it("usa o dia civil de Brasília", () => {
    // 15/10 02:00 UTC = 14/10 23:00 em Brasília -> ainda dia 30 do ciclo anterior (abriu em 15/09)
    expect(diaDoCicloNoEnvio(15, new Date("2026-10-15T02:00:00Z"))).toBe(30);
    expect(diaDoCicloNoEnvio(15, new Date("2026-10-15T12:00:00Z"))).toBe(1);
    expect(diaDoCicloNoEnvio(null, new Date())).toBeNull();
  });
  it("faixas", () => {
    expect([1, 3, 4, 7, 8, 15, 16, 31].map(faixaDoDiaCiclo)).toEqual(["D1_3", "D1_3", "D4_7", "D4_7", "D8_15", "D8_15", "D16_MAIS", "D16_MAIS"]);
    expect(faixaDoDiaCiclo(null)).toBe("SEM_CICLO");
  });
});

describe("breakdownByCiclo", () => {
  const ev = (id: string, ref: string, primeiroUsoDia: number | null): any => ({
    id, clientId: id, variant: "A", cohort: "TRATADO", ref: new Date(ref), saldoNoEnvio: 100, grupoSaldo: "COM_SALDO", usos: primeiroUsoDia === null ? [] : [{ dayOffset: primeiroUsoDia, valorPrincipal: 100, juros: 10, kind: "ANTECIPACAO" }], primeiroUsoDia,
  });
  it("separa por faixa do dia do ciclo no envio", () => {
    const treated = [ev("a", "2026-10-15T12:00:00Z", 1), ev("b", "2026-10-16T12:00:00Z", null), ev("c", "2026-10-25T12:00:00Z", null)];
    const r = breakdownByCiclo(treated, [], () => 15, 7);
    expect(r.map((x) => [x.faixa, x.enviados])).toEqual([["D1_3", 2], ["D8_15", 1]]);
    expect(r[0].convertidos).toBe(1);
  });
});

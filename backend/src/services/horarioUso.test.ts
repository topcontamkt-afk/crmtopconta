import { ANTECEDENCIA_PADRAO_MIN, construirHorarios, estimarAntecedencia, picoDe, sugerirHorario } from "./horarioUso";

const seg = (key: string, clientes = 100) => ({ key, label: key, clientes });

describe("construirHorarios", () => {
  it("soma por hora e por segmento, achando o pico", () => {
    const r = construirHorarios(
      [
        { hora: 12, segmento: "PF1", usos: 40 },
        { hora: 11, segmento: "PF1", usos: 10 },
        { hora: 19, segmento: "PF2", usos: 50 },
      ],
      [seg("PF1"), seg("PF2")]
    );
    expect(r.total[12]).toBe(40);
    expect(r.usosTotal).toBe(100);
    expect(r.segmentos.find((s) => s.key === "PF1")?.picoHora).toBe(12);
    expect(r.segmentos.find((s) => s.key === "PF2")?.picoHora).toBe(19);
  });

  it("segmento com menos de 30 usos é 'poucos dados' e não tem pico", () => {
    const r = construirHorarios([{ hora: 10, segmento: "PF3", usos: 29 }], [seg("PF3")]);
    expect(r.segmentos[0]).toMatchObject({ poucosDados: true, picoHora: null, usos: 29 });
  });

  it("ignora hora inválida e uso não positivo", () => {
    const r = construirHorarios(
      [{ hora: 24, segmento: "a", usos: 50 }, { hora: -1, segmento: "a", usos: 50 }, { hora: 3.5, segmento: "a", usos: 50 }, { hora: 5, segmento: "a", usos: 0 }],
      [seg("a")]
    );
    expect(r.usosTotal).toBe(0);
  });

  it("segmento sem linhas aparece zerado", () => {
    expect(construirHorarios([], [seg("x")]).segmentos[0].usos).toBe(0);
  });
});

describe("picoDe", () => {
  it("em empate fica a hora mais cedo", () => {
    const h = new Array(24).fill(0);
    h[9] = 10;
    h[15] = 10;
    expect(picoDe(h)).toBe(9);
  });
});

describe("estimarAntecedencia", () => {
  it("amostra pequena usa o padrão e diz que é padrão", () => {
    expect(estimarAntecedencia([10, 20, 30])).toEqual({ fonte: "padrao", medianaMin: ANTECEDENCIA_PADRAO_MIN, p25Min: null, p75Min: null, amostra: 3 });
  });
  it("amostra suficiente mede mediana e quartis", () => {
    const atrasos = Array.from({ length: 40 }, (_, i) => (i + 1) * 2); // 2..80
    const r = estimarAntecedencia(atrasos);
    expect(r.fonte).toBe("medida");
    expect(r.medianaMin).toBe(41);
    expect(r.p25Min).toBeLessThan(r.medianaMin);
    expect(r.p75Min).toBeGreaterThan(r.medianaMin);
  });
  it("descarta atrasos fora de 0 a 24h", () => {
    const r = estimarAntecedencia([...Array.from({ length: 30 }, () => 20), -5, 5000, NaN]);
    expect(r.amostra).toBe(30);
    expect(r.medianaMin).toBe(20);
  });
});

describe("sugerirHorario", () => {
  const padrao = estimarAntecedencia([]);
  it("pico às 12h com 40 min de antecedência sugere 11:20", () => {
    const med = { fonte: "medida" as const, medianaMin: 40, p25Min: 25, p75Min: 70, amostra: 80 };
    expect(sugerirHorario(12, med, 300)).toMatchObject({ horario: "11:20", antecedenciaMin: 40, ajustadoPelaJanela: false, confianca: "alta" });
  });
  it("arredonda a 5 minutos", () => {
    const med = { fonte: "medida" as const, medianaMin: 42, p25Min: null, p75Min: null, amostra: 80 };
    expect(sugerirHorario(12, med, 50).horario).toBe("11:20"); // 11:18 -> 11:20
  });
  it("pico de madrugada é trazido para a janela comercial e marcado como ajustado", () => {
    const s = sugerirHorario(3, padrao, 500);
    expect(s).toMatchObject({ horario: "07:00", ajustadoPelaJanela: true });
  });
  it("pico depois das 21h fica em 21:00", () => {
    expect(sugerirHorario(23, padrao, 500).horario).toBe("21:00");
  });
  it("antecedência no padrão nunca passa de confiança baixa", () => {
    expect(sugerirHorario(12, padrao, 5000).confianca).toBe("baixa");
  });
});

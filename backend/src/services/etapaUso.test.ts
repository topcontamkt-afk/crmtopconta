import { classificarEtapa, etapaWhere, ETAPAS_USO } from "./etapaUso";
import { buildSegmentWhere } from "./segments";

const now = new Date("2026-10-10T12:00:00Z");
const ago = (d: number) => new Date(now.getTime() - d * 86400000);

describe("classificarEtapa", () => {
  it("sem uso no extrato = nunca usou", () => {
    expect(classificarEtapa({ ultimoUsoReal: null, usosUltimos90d: 0, usosTotal: 0 }, now)).toBe("NUNCA_USOU");
  });
  it("usou nos últimos 30 dias: 3+ usos em 90d é recorrente, menos é ocasional", () => {
    expect(classificarEtapa({ ultimoUsoReal: ago(5), usosUltimos90d: 3, usosTotal: 3 }, now)).toBe("RECORRENTE");
    expect(classificarEtapa({ ultimoUsoReal: ago(30), usosUltimos90d: 2, usosTotal: 9 }, now)).toBe("OCASIONAL");
  });
  it("31–90 dias sem uso = em risco; mais de 90 = inativo", () => {
    expect(classificarEtapa({ ultimoUsoReal: ago(31), usosUltimos90d: 4, usosTotal: 4 }, now)).toBe("EM_RISCO");
    expect(classificarEtapa({ ultimoUsoReal: ago(90), usosUltimos90d: 1, usosTotal: 1 }, now)).toBe("EM_RISCO");
    expect(classificarEtapa({ ultimoUsoReal: ago(91), usosUltimos90d: 0, usosTotal: 5 }, now)).toBe("INATIVO");
  });
});

describe("etapaWhere / filtros", () => {
  it("cada etapa tem um filtro", () => {
    for (const e of ETAPAS_USO) expect(etapaWhere(e, now)).toBeDefined();
  });
  it("etapaUso, usos e dias sem uso real viram condições de coluna", () => {
    const where: any = buildSegmentWhere("t1", { etapaUso: ["INATIVO"], usosMin: 2, usosMax: 5, diasSemUsoRealMin: 60 });
    const txt = JSON.stringify(where);
    expect(txt).toContain("ultimoUsoReal");
    expect(where.AND).toContainEqual({ usosUltimos90d: { gte: 2 } });
    expect(where.AND).toContainEqual({ usosUltimos90d: { lte: 5 } });
  });
  it("diasSemUsoRealMin inclui quem nunca usou", () => {
    const where: any = buildSegmentWhere("t1", { diasSemUsoRealMin: 30 });
    expect(where.AND[0].OR[0]).toEqual({ ultimoUsoReal: null });
  });
});

import { breakdownByPerfil } from "./campaignPerfil";
import { avaliarFrescor } from "./dataFreshness";
import type { EventEvaluation } from "./campaignResults";

const ev = (clientId: string, usou: boolean): EventEvaluation =>
  ({
    id: clientId, clientId, ref: new Date("2026-10-01T12:00:00Z"), cohort: "TRATADO", variant: "A", grupoSaldo: "COM_SALDO",
    usos: usou ? [{ clientId, confirmedAt: new Date("2026-10-02T12:00:00Z"), kind: "ANTECIPACAO", valorPrincipal: 500, juros: 40, dayOffset: 1 }] : [],
  }) as any;

describe("breakdownByPerfil", () => {
  const perfis: Record<string, any> = { a: "PF1", b: "PF1", c: "PF2", d: null };
  const of = (id: string) => perfis[id] ?? null;

  it("separa conversão e lucro por perfil, com SEM_PERFIL à parte", () => {
    const r = breakdownByPerfil([ev("a", true), ev("b", false), ev("c", true), ev("d", false)], [], of, 7);
    expect(r.find((x) => x.perfil === "PF1")).toMatchObject({ enviados: 2, convertidos: 1, lucro: 40 });
    expect(r.find((x) => x.perfil === "PF2")).toMatchObject({ enviados: 1, convertidos: 1 });
    expect(r.find((x) => x.perfil === "SEM_PERFIL")).toMatchObject({ enviados: 1, convertidos: 0 });
    expect(r.find((x) => x.perfil === "PF3")).toBeUndefined();
  });

  it("compara com o controle do mesmo perfil", () => {
    const ctrl = { ...ev("e", false), cohort: "CONTROLE" } as any;
    perfis.e = "PF1";
    const r = breakdownByPerfil([ev("a", true)], [ctrl], of, 7);
    expect(r[0]).toMatchObject({ perfil: "PF1", controle: 1, taxaControle: 0 });
  });
});

describe("avaliarFrescor", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  it("sem transação = sem dados", () => expect(avaliarFrescor(null, now).status).toBe("SEM_DADOS"));
  it("até 3 dias está ok", () => expect(avaliarFrescor(new Date("2026-10-07T12:00:00Z"), now).status).toBe("OK"));
  it("mais de 3 dias está desatualizado", () => {
    const f = avaliarFrescor(new Date("2026-10-05T12:00:00Z"), now);
    expect(f).toMatchObject({ status: "DESATUALIZADO", diasDefasagem: 5 });
  });
});

import { callingChecks, tierRecipients } from "./whatsappCalling";

describe("tierRecipients", () => {
  it("lê os níveis da Meta", () => {
    expect(tierRecipients("TIER_250")).toBe(250);
    expect(tierRecipients("TIER_1K")).toBe(1000);
    expect(tierRecipients("TIER_10K")).toBe(10000);
    expect(tierRecipients("TIER_100K")).toBe(100000);
    expect(tierRecipients("TIER_UNLIMITED")).toBe(Infinity);
  });
  it("devolve null para o que não conhece", () => {
    expect(tierRecipients(null)).toBeNull();
    expect(tierRecipients("")).toBeNull();
    expect(tierRecipients("OUTRA_COISA")).toBeNull();
  });
});

describe("callingChecks", () => {
  it("aprova com 10K e ligações ligadas", () => {
    const c = callingChecks({ tier: "TIER_10K", callingStatus: "ENABLED" });
    expect(c.map((x) => x.ok)).toEqual([true, true]);
  });
  it("reprova 1K (abaixo de 2.000) e ligações desligadas", () => {
    const c = callingChecks({ tier: "TIER_1K", callingStatus: "DISABLED" });
    expect(c.map((x) => x.ok)).toEqual([false, false]);
    expect(c[0].detalhe).toContain("2.000");
  });
  it("não afirma nada quando a Meta não deixa ler", () => {
    const c = callingChecks({ tierError: "sem permissão", callingError: "HTTP 400" });
    expect(c.map((x) => x.ok)).toEqual([null, null]);
  });
  it("campo ausente: limite desconhecido, ligações desligadas", () => {
    const c = callingChecks({});
    expect(c[0].ok).toBeNull();
    expect(c[1].ok).toBe(false);
  });
});

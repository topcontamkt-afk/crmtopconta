import { addDiasIso } from "./diasIso";

describe("addDiasIso", () => {
  it("soma e subtrai atravessando mês e ano", () => {
    expect(addDiasIso("2026-10-16", -29)).toBe("2026-09-17");
    expect(addDiasIso("2026-01-05", -10)).toBe("2025-12-26");
    expect(addDiasIso("2026-02-27", 3)).toBe("2026-03-02");
  });
  it("ano bissexto", () => {
    expect(addDiasIso("2028-03-01", -1)).toBe("2028-02-29");
  });
  it("zero não muda", () => {
    expect(addDiasIso("2026-10-16", 0)).toBe("2026-10-16");
  });
});

/** Soma dias (positivos ou negativos) a um dia civil "YYYY-MM-DD", sem fuso: o SQLite do D1 compara datas como texto. */
export function addDiasIso(dia: string, n: number): string {
  const [y, m, d] = dia.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

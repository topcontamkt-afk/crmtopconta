/**
 * Listas longas em consultas do Prisma no D1 (~98 valores por consulta). O Prisma 7 só divide sozinho um `in` em
 * findMany/findFirst/updateMany/deleteMany com UM `in`, sem `orderBy` e sem `not`/`notIn`; o resto (count,
 * groupBy, aggregate, `orderBy`, `not`, dois `in`) dá P2029. Ver docs/infra/cloudflare-ambientes.md.
 */

/** Valores por pedaço: sobra espaço para o tenantId e os outros filtros da mesma consulta. */
export const LOTE_IN = 90;

export function partes<T>(xs: readonly T[], tamanho = LOTE_IN): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += tamanho) out.push(xs.slice(i, i + tamanho));
  return out;
}

/**
 * Um `where` com `campo: { in: [...] }` longo no nível de cima vira um `where` por pedaço (cada um cabe no D1,
 * sejam quais forem os outros filtros). Sem lista longa, devolve o próprio `where`. Os pedaços não se cruzam,
 * então somar contagens e juntar linhas dá o mesmo resultado da consulta inteira.
 */
export function dividirIn<W extends object>(where: W, campo = "id"): W[] {
  const filtro = (where as Record<string, unknown>)[campo] as { in?: unknown[] } | undefined;
  const lista = filtro && typeof filtro === "object" && Array.isArray(filtro.in) ? filtro.in : null;
  if (!lista || lista.length <= LOTE_IN) return [where];
  return partes(lista).map((parte) => ({ ...where, [campo]: { ...filtro, in: parte } }));
}

/** Linhas de `consulta` para cada pedaço do `where` (em paralelo), juntas. */
export async function buscarEmPartes<W extends object, R>(where: W, consulta: (w: W) => Promise<R[]>, campo = "id"): Promise<R[]> {
  return (await Promise.all(dividirIn(where, campo).map(consulta))).flat();
}

/** Soma de `contar` para cada pedaço do `where`. */
export async function contarEmPartes<W extends object>(where: W, contar: (w: W) => Promise<number>, campo = "id"): Promise<number> {
  return (await Promise.all(dividirIn(where, campo).map(contar))).reduce((a, n) => a + n, 0);
}

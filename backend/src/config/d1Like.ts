import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

/**
 * better-sqlite3 (Node: testes de integração e seed) com os limites do D1 que mudam o comportamento do código:
 *  - o adapter do D1 informa ao Prisma no máximo 98 valores por consulta (`maxBindValues`): o Prisma divide sozinho
 *    um `in` simples e recusa com P2029 o que não sabe dividir (ex.: dois `in` dentro de um OR). O better-sqlite3
 *    não informa limite nenhum, então sem isso os testes passavam e o Worker quebrava;
 *  - o próprio D1 recusa SQL cru com mais de 100 parâmetros.
 * Só para Node; o Worker usa o PrismaD1 de verdade.
 */
export const D1_MAX_BIND_VALUES = 98;
const D1_MAX_PARAMS = 100;

type Adapter = Awaited<ReturnType<PrismaBetterSqlite3["connect"]>>;

function comLimites<T extends object>(alvo: T): T {
  return new Proxy(alvo, {
    get(t, p, r) {
      if (p === "getConnectionInfo") return () => ({ maxBindValues: D1_MAX_BIND_VALUES, supportsRelationJoins: false });
      const v = Reflect.get(t, p, r);
      if (typeof v !== "function") return v;
      if (p === "queryRaw" || p === "executeRaw") {
        return (query: { args?: unknown[] }, ...rest: unknown[]) => {
          if ((query?.args?.length ?? 0) > D1_MAX_PARAMS) {
            throw new Error(`[d1Like] consulta com ${query.args!.length} parâmetros: o D1 aceita até ${D1_MAX_PARAMS}`);
          }
          return v.call(t, query, ...rest);
        };
      }
      if (p === "startTransaction") return async (...a: unknown[]) => comLimites(await v.apply(t, a));
      return v.bind(t);
    },
  });
}

/** Fábrica de adapter para `configureDatabase`/`new PrismaClient({ adapter })`, com os limites do D1. */
export function d1LikeAdapter(url: string): PrismaBetterSqlite3 {
  const factory = new PrismaBetterSqlite3({ url });
  return new Proxy(factory, {
    get(t, p, r) {
      if (p === "connect") return async (): Promise<Adapter> => comLimites(await t.connect());
      const v = Reflect.get(t, p, r);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

import { PrismaClient } from "../generated/prisma/client";
import { checkRawTenant, tenantGuardExtension } from "./tenantGuard";
import { derivedColumnsExtension } from "./derivedColumns";

/**
 * Client do Prisma 7 com o isolamento por tenant (config/tenantGuard.ts). O banco chega por adapter,
 * que cada ambiente registra uma vez com `configureDatabase`:
 * - Worker (backend/worker/index.ts): `new PrismaD1(env.DB)`, o binding D1;
 * - Node (testes de integração, seed): `new PrismaBetterSqlite3({ url })`, com as mesmas migrations.
 *
 * `prisma` é um Proxy: o client só é montado no primeiro uso (o binding do D1 não existe quando o
 * módulo carrega) e depois é reaproveitado pelo isolate inteiro. Assim todos os arquivos continuam
 * com `import { prisma } from "../config/db"`.
 */
type DatabaseAdapter = NonNullable<NonNullable<ConstructorParameters<typeof PrismaClient>[0]>["adapter"]>;

let adapterFactory: (() => DatabaseAdapter) | undefined;

function buildClient() {
  if (!adapterFactory) {
    throw new Error("[db] banco não configurado: chame configureDatabase() na entrada (Worker ou script)");
  }
  return new PrismaClient({ adapter: adapterFactory() }).$extends(tenantGuardExtension).$extends(derivedColumnsExtension);
}

// O `$extends()` tira `$on`/`$use` do tipo, então ele não é atribuível a `PrismaClient`. Funções que
// recebem o client compartilhado como parâmetro usam este alias.
export type AppPrismaClient = ReturnType<typeof buildClient>;

let client: AppPrismaClient | undefined;

/** Registra o adapter do banco. Chamar de novo troca o banco (usado pelos testes de integração). */
export function configureDatabase(factory: () => DatabaseAdapter): void {
  adapterFactory = factory;
  client = undefined;
}

export const prisma = new Proxy({} as AppPrismaClient, {
  get(_target, prop) {
    const c = (client ??= buildClient());
    const value = Reflect.get(c, prop, c);
    return typeof value === "function" ? value.bind(c) : value;
  },
});

/**
 * Parâmetros numerados (`$1`, `$2`, …, o mesmo número pode repetir) viram `?` posicionais, com os
 * valores na ordem em que aparecem. O D1 aceitaria `?1`, mas o better-sqlite3 dos testes não aceita
 * número com lista de valores; `?` simples funciona igual nos dois.
 */
export function positionalParams(sql: string, params: unknown[]): { sql: string; params: unknown[] } {
  const out: unknown[] = [];
  const text = sql.replace(/\$(\d+)/g, (_m, n: string) => {
    const i = Number(n) - 1;
    if (i < 0 || i >= params.length) throw new Error(`[db] SQL cru usa $${n}, mas só há ${params.length} parâmetro(s)`);
    out.push(params[i]);
    return "?";
  });
  return { sql: text, params: out };
}

/**
 * Linhas do SQL cru no mesmo formato nos dois adapters. O tipo de uma coluna calculada (COUNT, SUM,
 * MAX(...)) é adivinhado pelo valor: no better-sqlite3 dos testes inteiro vem como BigInt, no D1 como
 * number; e o D1 devolve como Date o texto que parece data ISO, o better-sqlite3 devolve o texto. Aqui
 * inteiro é sempre number e data é sempre texto ISO (`new Date(...)` lê os dois formatos gravados).
 */
export function normalizeRawRows<T>(rows: T): T {
  if (!Array.isArray(rows)) return rows;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    for (const k of Object.keys(r)) {
      const v = r[k];
      if (typeof v === "bigint") r[k] = Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
      else if (v instanceof Date) r[k] = v.toISOString();
    }
  }
  return rows;
}

/**
 * SQL cru. Não passa pela extensão do Prisma, então `checkRawTenant` exige o filtro
 * `"tenantId" = $1` com o tenant do contexto como 1º parâmetro. Os valores sempre vão como
 * parâmetros (`$n`, ver `positionalParams`), nunca interpolados no texto.
 */
export const tenantRaw = {
  query: async <T = unknown>(sql: string, ...params: unknown[]): Promise<T> => {
    checkRawTenant(sql, params);
    const q = positionalParams(sql, params);
    return normalizeRawRows(await prisma.$queryRawUnsafe<T>(q.sql, ...q.params));
  },
  execute: async (sql: string, ...params: unknown[]): Promise<number> => {
    checkRawTenant(sql, params);
    const q = positionalParams(sql, params);
    return prisma.$executeRawUnsafe(q.sql, ...q.params);
  },
};

import { Prisma } from "../generated/prisma/client";
import { cidadeKey } from "../services/cidades";
import { classifyTransaction } from "../services/transactionClassifier";

/**
 * Colunas calculadas em JS a cada gravação, porque o SQLite não tem regex nem lower()/unaccent fora do ASCII e o
 * SQL cru (dashboard, comércio, ciclos) precisa filtrar e agrupar por elas:
 *  - Client.cidadeKey  = cidadeKey(cidade)      (services/cidades.ts)
 *  - Client.nomeBusca  = textoBusca(nome)        (busca por nome sem acento e sem caixa)
 *  - Purchase.usoTipo  = classifyTransaction(tipo).kind
 * A extensão olha o `data` de create/createMany/update/updateMany/upsert desses dois models: sempre que a coluna
 * de origem vem na gravação, a derivada vai junto. Gravar a derivada à mão é recusado (sairia do sincronismo).
 * SQL cru que muda cidade/nome/tipo precisa recalcular a derivada também (hoje nenhum muda).
 */

/** Minúsculas, sem acento, espaços colapsados. */
export function textoBusca(valor: string | null | undefined): string {
  return (valor ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

type Regra = { origem: string; derivada: string; calcula: (v: unknown) => string };

const REGRAS: Record<string, Regra[]> = {
  Client: [
    { origem: "cidade", derivada: "cidadeKey", calcula: (v) => cidadeKey(v as string | null) },
    { origem: "nome", derivada: "nomeBusca", calcula: (v) => textoBusca(v as string | null) },
  ],
  Purchase: [{ origem: "tipo", derivada: "usoTipo", calcula: (v) => classifyTransaction(String(v ?? "")).kind }],
};

/** Valor escrito numa coluna: direto ou `{ set: valor }`. undefined = a coluna não está na gravação. */
function valorGravado(data: Record<string, unknown>, campo: string): { ok: boolean; valor?: unknown } {
  if (!(campo in data) || data[campo] === undefined) return { ok: false };
  const v = data[campo];
  if (v && typeof v === "object" && !(v instanceof Date) && "set" in (v as object)) return { ok: true, valor: (v as { set: unknown }).set };
  return { ok: true, valor: v };
}

function comDerivadas(model: string, data: unknown): unknown {
  if (Array.isArray(data)) return data.map((d) => comDerivadas(model, d));
  if (!data || typeof data !== "object") return data;
  const out: Record<string, unknown> = { ...(data as Record<string, unknown>) };
  for (const r of REGRAS[model] ?? []) {
    if (r.derivada in out) throw new Error(`[derivedColumns] ${model}.${r.derivada} é calculada a partir de ${r.origem}; não grave à mão.`);
    const g = valorGravado(out, r.origem);
    if (g.ok) out[r.derivada] = r.calcula(g.valor);
  }
  return out;
}

/** Aplica as regras aos argumentos de uma operação de escrita (exportada para teste). */
export function derivarArgs(model: string, operation: string, args: any): any {
  if (!REGRAS[model] || !args) return args;
  switch (operation) {
    case "create":
    case "createMany":
    case "createManyAndReturn":
    case "update":
    case "updateMany":
    case "updateManyAndReturn":
      return { ...args, data: comDerivadas(model, args.data) };
    case "upsert":
      return { ...args, create: comDerivadas(model, args.create), update: comDerivadas(model, args.update) };
    default:
      return args;
  }
}

export const derivedColumnsExtension = Prisma.defineExtension((client) =>
  client.$extends({
    name: "derivedColumns",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          return query(derivarArgs(model, operation, args) as typeof args);
        },
      },
    },
  })
);

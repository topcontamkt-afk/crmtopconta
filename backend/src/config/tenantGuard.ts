import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma } from "../generated/prisma/client";

/**
 * Isolamento por tenant no D1 (SQLite), que não tem RLS. No Postgres antigo quem filtrava de verdade
 * era a RLS; aqui é esta extensão do Prisma, então ela não só confere, ela **injeta**:
 *
 * - toda operação com `where` (inclusive findUnique, update, delete e upsert) recebe
 *   `tenantId = <tenant do contexto>` no nível de cima do `where`. Um id de outro tenant não acha nada
 *   (o findUnique devolve null, o update/delete lança "registro não encontrado");
 * - todo `create`/`createMany` recebe o `tenantId` do contexto quando o `data` não traz um;
 * - `tenantId` explícito diferente do contexto (no `where` ou no `data`) é erro: nunca é silencioso;
 * - no model `Tenant` o mesmo vale para o `id`: no contexto de um tenant, só ele é visível.
 *
 * Falha fechada: sem contexto de tenant (fora de uma request autenticada ou de
 * `runWithTenantContextAsync`) e fora de `withCrossTenantAccess`, toda query lança erro, e model
 * desconhecido (novo no schema sem entrar na lista abaixo) também.
 *
 * Limite conhecido: relações carregadas por `include`/`select` não são filtradas. Elas partem de um
 * registro já filtrado e as chaves estrangeiras não atravessam tenants (todo create recebe o tenant do
 * contexto), então só vazariam se o banco já tivesse uma ligação errada.
 */

/**
 * Todo model com coluna `tenantId` própria. `Movement`, `MessageEvent` e `ClientTag` entraram na
 * migração para o D1: sem RLS, a coluna própria é o que permite injetar o filtro.
 * `tenantGuard.test.ts` confere esta lista contra o schema.
 */
export const TENANT_SCOPED_MODELS = [
  "User",
  "Client",
  "ClientTag",
  "ImportJob",
  "ImportChange",
  "Movement",
  "AccountSnapshot",
  "SegmentDefinition",
  "Campaign",
  "MessageEvent",
  "CampaignRecipient",
  "AutomationRule",
  "AuditLog",
  "SheetConnection",
  "ChannelConfig",
  "MessageTemplate",
  "TemplateMedia",
  "Notification",
  "DashboardSnapshot",
  "Merchant",
  "Purchase",
  "WhatsAppAccount",
  "Conversation",
  "WaMessage",
  "WaMediaBlob",
  "SupressaoTitular",
  "PedidoTitular",
  "CicloCidade",
] as const;

const SCOPED = new Set<string>(TENANT_SCOPED_MODELS);

/** O próprio tenant: filtrado pelo `id`, não por `tenantId`. */
const TENANT_MODEL = "Tenant";

/** Operações que levam `where`. */
const WHERE_OPERATIONS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "delete",
  "deleteMany",
  "upsert",
]);

/** Operações que levam `data` de criação. */
const CREATE_OPERATIONS = new Set(["create", "createMany", "createManyAndReturn"]);

/** Operações cujo `data` é de alteração (não pode trocar o tenant de uma linha). */
const UPDATE_OPERATIONS = new Set(["update", "updateMany", "updateManyAndReturn"]);

/**
 * Confere se um `where` menciona `tenantId`, inclusive dentro de AND/OR/NOT (formato que
 * services/segments.ts `buildGroupWhere` monta). Não decide nada sobre o isolamento (a injeção cuida
 * disso); fica exportada para quem monta filtros conferir o próprio resultado.
 */
export function whereHasTenantId(where: unknown): boolean {
  if (!where || typeof where !== "object") return false;
  const w = where as Record<string, unknown>;
  if ("tenantId" in w) return true;
  for (const combinator of ["AND", "OR", "NOT"] as const) {
    const value = w[combinator];
    if (value === undefined) continue;
    const items = Array.isArray(value) ? value : [value];
    if (items.some((item) => whereHasTenantId(item))) return true;
  }
  return false;
}

/**
 * Desvio para o que é cross-tenant de propósito: jobs agendados que varrem todos os tenants
 * (services/scheduler.ts, automationEngine.ts, retention.ts…) e webhooks que descobrem o tenant pelo
 * corpo (phone_number_id, segredo da URL). Dentro do callback as queries rodam SEM injeção. Envolva só
 * a chamada que precisa, com um comentário no local explicando por quê; todo uso é uma exceção revisada
 * à mão (grep por `withCrossTenantAccess`).
 */
const bypassContext = new AsyncLocalStorage<boolean>();

export function withCrossTenantAccess<T>(fn: () => Promise<T>): Promise<T> {
  // `await` dentro do run(): as queries do Prisma são thenables preguiçosos, e o hook só roda no
  // `.then()`. Sem o await aqui, ele rodaria depois que o contexto do run() já acabou.
  return bypassContext.run(true, async () => await fn());
}

/** tenantId da request atual (middleware/auth.ts) ou do job que processa um tenant por vez. */
const requestTenantContext = new AsyncLocalStorage<string>();

/** Versão síncrona: middleware/auth.ts envolve `next()`, e o resto da cadeia herda o contexto. */
export function runWithTenantContext<T>(tenantId: string, fn: () => T): T {
  return requestTenantContext.run(tenantId, fn);
}

/** Para trabalho assíncrono (jobs por tenant depois de uma varredura cross-tenant). */
export function runWithTenantContextAsync<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return requestTenantContext.run(tenantId, async () => await fn());
}

/** Tenant do contexto atual, ou undefined fora de request/job. */
export function currentTenantId(): string | undefined {
  return requestTenantContext.getStore();
}

function guardError(model: string, operation: string, motivo: string): Error {
  return new Error(`[tenantGuard] Recusado ${model}.${operation}(): ${motivo}`);
}

/** Injeta `campo = tenantId` no `where`, recusando um valor explícito diferente. */
function scopeWhere(model: string, operation: string, where: unknown, campo: string, tenantId: string) {
  const w = where && typeof where === "object" ? (where as Record<string, unknown>) : {};
  if (campo in w && w[campo] !== undefined && w[campo] !== tenantId) {
    throw guardError(model, operation, `"${campo}" do where não é o tenant do contexto`);
  }
  // Chave única composta que já começa pelo tenant (`tenantId_cpfHash: { tenantId, cpfHash }`): conferida e
  // mantida sem o `tenantId` solto ao lado. Com o campo extra, o Prisma deixa de fazer o upsert nativo
  // (INSERT ... ON CONFLICT, 1 consulta) e cai em ler + gravar + ler numa transação (~5 consultas por linha),
  // o que estoura o limite de consultas por invocação do D1 numa importação.
  if (campo === "tenantId") {
    const compostas = Object.keys(w).filter((k) => k.startsWith("tenantId_") && w[k] && typeof w[k] === "object");
    for (const k of compostas) {
      if ((w[k] as Record<string, unknown>).tenantId !== tenantId) {
        throw guardError(model, operation, `"${k}.tenantId" do where não é o tenant do contexto`);
      }
    }
    if (compostas.length) return w;
  }
  return { ...w, [campo]: tenantId };
}

/** Preenche (ou confere) `tenantId` em cada item de `data` de criação. */
function scopeCreateData(model: string, operation: string, data: unknown, tenantId: string) {
  const fill = (item: unknown) => {
    if (!item || typeof item !== "object") throw guardError(model, operation, "data inválido");
    const d = item as Record<string, unknown>;
    if (d.tenantId !== undefined && d.tenantId !== tenantId) {
      throw guardError(model, operation, '"tenantId" do data não é o tenant do contexto');
    }
    // `tenant: { connect }` (forma com relação) não convive com `tenantId`: só confere.
    if (d.tenant !== undefined) {
      const id = (d.tenant as { connect?: { id?: unknown } })?.connect?.id;
      if (id !== tenantId) throw guardError(model, operation, "relação tenant não é o tenant do contexto");
      return d;
    }
    return { ...d, tenantId };
  };
  return Array.isArray(data) ? data.map(fill) : fill(data);
}

/** `data` de alteração não pode mover a linha para outro tenant. */
function checkUpdateData(model: string, operation: string, data: unknown, tenantId: string) {
  const d = data as Record<string, unknown> | undefined;
  if (d && d.tenantId !== undefined && d.tenantId !== tenantId) {
    throw guardError(model, operation, "não é permitido trocar o tenantId de uma linha");
  }
}

/** Reescreve os argumentos de uma operação para o tenant do contexto (exportada para os testes). */
export function scopeArgs(model: string, operation: string, args: unknown, tenantId: string): Record<string, unknown> {
  const a = { ...((args as Record<string, unknown> | undefined) ?? {}) };

  if (model === TENANT_MODEL) {
    if (!WHERE_OPERATIONS.has(operation) || operation === "upsert") {
      throw guardError(model, operation, "Tenant só é criado fora do contexto de um tenant (seed/withCrossTenantAccess)");
    }
    a.where = scopeWhere(model, operation, a.where, "id", tenantId);
    return a;
  }

  if (!SCOPED.has(model)) {
    throw guardError(model, operation, "model fora de TENANT_SCOPED_MODELS (inclua-o em config/tenantGuard.ts)");
  }

  if (CREATE_OPERATIONS.has(operation)) {
    a.data = scopeCreateData(model, operation, a.data, tenantId);
    return a;
  }
  if (!WHERE_OPERATIONS.has(operation)) {
    throw guardError(model, operation, "operação desconhecida para o guard");
  }
  a.where = scopeWhere(model, operation, a.where, "tenantId", tenantId);
  if (UPDATE_OPERATIONS.has(operation)) checkUpdateData(model, operation, a.data, tenantId);
  if (operation === "upsert") {
    a.create = scopeCreateData(model, operation, a.create, tenantId);
    checkUpdateData(model, operation, a.update, tenantId);
  }
  return a;
}

/** Extensão do Prisma que aplica o isolamento descrito no topo do arquivo. */
export const tenantGuardExtension = Prisma.defineExtension((client) =>
  client.$extends({
    name: "tenantGuard",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (bypassContext.getStore()) return query(args);
          const tenantId = requestTenantContext.getStore();
          if (!tenantId) {
            throw guardError(
              model,
              operation,
              "sem contexto de tenant. Fora de uma request autenticada use runWithTenantContextAsync() " +
                "ou, se for cross-tenant de propósito, withCrossTenantAccess()"
            );
          }
          // `query` aceita os argumentos reescritos; o tipo dele é por operação, daí o cast.
          return query(scopeArgs(model, operation, args, tenantId) as typeof args);
        },
      },
    },
  })
);

/**
 * SQL cru não passa pela extensão acima. Para não depender de cada chamador lembrar do filtro,
 * `tenantRaw` (config/db.ts) exige contexto de tenant e que o SQL filtre `"tenantId" = $1`, com o
 * tenant do contexto como PRIMEIRO parâmetro.
 * Dentro de `withCrossTenantAccess` a conferência não se aplica.
 */
export function checkRawTenant(sql: string, params: unknown[]): void {
  if (bypassContext.getStore()) return;
  const tenantId = requestTenantContext.getStore();
  if (!tenantId) throw new Error("[tenantGuard] SQL cru recusado: sem contexto de tenant");
  if (params[0] !== tenantId) {
    throw new Error("[tenantGuard] SQL cru recusado: o 1º parâmetro tem de ser o tenant do contexto");
  }
  if (!/"tenantId"\s*=\s*\$1(?!\d)/.test(sql)) {
    throw new Error('[tenantGuard] SQL cru recusado: o SQL precisa filtrar "tenantId" = $1');
  }
}

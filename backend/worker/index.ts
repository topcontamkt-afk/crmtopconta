// Entrada do Worker. A SPA sai direto dos assets; aqui só chega /api/* e /r/* (run_worker_first).
// Fase 2: o banco já é o Prisma 7 + D1 com o isolamento por tenant (src/config/db.ts). A API real
// (Express) entra na Fase 3; até lá, só o health responde e o resto devolve 503.
import { env } from "cloudflare:workers";
import { PrismaD1 } from "@prisma/adapter-d1";
import { configureDatabase, prisma } from "../src/config/db";
import { withCrossTenantAccess } from "../src/config/tenantGuard";

interface Env {
  DB: D1Database;
  MEDIA?: R2Bucket;
  ASSETS: Fetcher;
  APP_ENV: string;
}

configureDatabase(() => new PrismaD1((env as unknown as Env).DB));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

async function health(env: Env) {
  const inicio = Date.now();
  try {
    // Passa pelo client do Prisma (compilador WASM + adapter D1), não só pelo binding. Cross-tenant
    // de propósito: o health não tem tenant, e só confere que a tabela existe (migrations aplicadas).
    await withCrossTenantAccess(() => prisma.tenant.count());
    return json({ ok: true, ambiente: env.APP_ENV, banco: "ok", latenciaBancoMs: Date.now() - inicio, r2: !!env.MEDIA });
  } catch {
    // nunca devolve a mensagem do driver (pode carregar detalhe interno)
    return json({ ok: false, ambiente: env.APP_ENV, banco: "erro" }, 503);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/health") return health(env);
    if (pathname.startsWith("/api/") || pathname.startsWith("/r/")) {
      return json({ error: "API em migração para a Cloudflare", code: "EM_MIGRACAO" }, 503);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

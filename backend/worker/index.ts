// Entrada do Worker. A SPA sai direto dos assets; aqui só chega /api/* e /r/* (run_worker_first),
// que vão para o mesmo Express de sempre (src/app.ts) via `httpServerHandler` (nodejs_compat).
// O banco é o Prisma 7 + D1 com o isolamento por tenant (src/config/db.ts).
import { env, waitUntil } from "cloudflare:workers";
import { httpServerHandler } from "cloudflare:node";
import { PrismaD1 } from "@prisma/adapter-d1";
import { configureBackground } from "../src/config/background";
import { configureMediaStore, r2MediaStore } from "../src/services/mediaStore";
import { configureDatabase, prisma } from "../src/config/db";
import { withCrossTenantAccess } from "../src/config/tenantGuard";
import { runCronTrigger } from "../src/services/cronTriggers";
import { configureSyncQueue, PaginaSync, tratarMensagemSync } from "../src/services/sheetSync";
import app from "../src/app";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

interface Env {
  DB: D1Database;
  MEDIA?: R2Bucket;
  SYNC_QUEUE?: { send(body: PaginaSync): Promise<void> };
  ASSETS: { fetch(request: Request): Promise<Response> };
  APP_ENV: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
configureDatabase(() => new PrismaD1((env as any).DB));
configureBackground(waitUntil);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
configureMediaStore(r2MediaStore((env as any).MEDIA));
// Sync da planilha em páginas (services/sheetSync.ts). Sem o binding, roda inteiro numa invocação.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const syncQueue = (env as any).SYNC_QUEUE as Env["SYNC_QUEUE"];
configureSyncQueue(syncQueue ? { send: (msg) => syncQueue.send(msg) } : null);

// O Express escuta numa porta "virtual" do workerd; o handler entrega cada Request a ela.
const PORT = 3000;
app.listen(PORT);
const express = httpServerHandler({ port: PORT }) as { fetch(request: Request, env: Env, ctx: unknown): Promise<Response> };

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

// Tipos do Node (Request/Response globais) em vez dos da Cloudflare: ver worker/cloudflare.d.ts.
export default {
  async fetch(request: Request, env: Env, ctx: unknown): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/health") return health(env);
    if (pathname.startsWith("/api/") || pathname.startsWith("/r/")) return express.fetch(request, env, ctx);
    return env.ASSETS.fetch(request);
  },

  // Cron Triggers do wrangler.jsonc. Aguarda os jobs até o fim (o runtime mantém a invocação viva enquanto a
  // promessa não resolve); um job com erro não derruba os seguintes (ver runCronTrigger).
  async scheduled(controller: { cron: string; scheduledTime: number }): Promise<void> {
    await runCronTrigger(controller.cron, new Date(controller.scheduledTime));
  },

  // Consumidor da fila do sync da planilha (max_batch_size 1: uma página por invocação, cada uma com o próprio teto
  // de CPU e de consultas ao D1).
  async queue(batch: { messages: readonly { body: unknown; attempts: number; ack(): void; retry(): void }[] }): Promise<void> {
    for (const m of batch.messages) {
      const r = await tratarMensagemSync(m.body as PaginaSync, m.attempts);
      if (r === "ok") m.ack();
      else m.retry();
    }
  },
};

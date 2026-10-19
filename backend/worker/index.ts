// Entrada do Worker (Fase 1: esqueleto). A SPA sai direto dos assets; aqui só chega
// /api/* e /r/* (run_worker_first). A API real (Express + Prisma 7 + D1) entra na Fase 2/3;
// até lá, só o health responde e o resto devolve 503.

interface Env {
  DB: D1Database;
  MEDIA?: R2Bucket;
  ASSETS: Fetcher;
  APP_ENV: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

async function health(env: Env) {
  const inicio = Date.now();
  try {
    await env.DB.prepare("SELECT 1").first();
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

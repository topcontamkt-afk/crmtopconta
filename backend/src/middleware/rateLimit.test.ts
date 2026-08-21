import express, { Express } from "express";
import request from "supertest";

/**
 * Cada teste chama jest.resetModules() e faz require("./rateLimit") de novo antes de montar o
 * app de teste. O MemoryStore do express-rate-limit é criado uma vez, no import do módulo, e
 * fica vivo (com os contadores acumulando) enquanto a instância do módulo existir — sem isso,
 * os testes iriam interferir uns nos outros (todos batendo do mesmo IP de loopback do
 * supertest) e o limite pareceria disparar antes ou depois do esperado dependendo da ordem de
 * execução.
 */
function freshRateLimitModule() {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("./rateLimit") as typeof import("./rateLimit");
}

describe("twoFactorVerifyLimiter", () => {
  function buildApp(): Express {
    const { twoFactorVerifyLimiter } = freshRateLimitModule();
    const app = express();
    app.post("/api/auth/2fa/verify", twoFactorVerifyLimiter, (_req, res) => res.json({ ok: true }));
    return app;
  }

  it("permite requisições dentro do limite (10 a cada 15min)", async () => {
    const app = buildApp();
    for (let i = 0; i < 10; i++) {
      const res = await request(app).post("/api/auth/2fa/verify").send({});
      expect(res.status).toBe(200);
    }
  });

  it("retorna 429 com corpo { error } na 11ª requisição", async () => {
    const app = buildApp();
    for (let i = 0; i < 10; i++) {
      await request(app).post("/api/auth/2fa/verify").send({});
    }
    const res = await request(app).post("/api/auth/2fa/verify").send({});
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: expect.any(String) });
  });
});

describe("webhookLimiter", () => {
  function buildApp(): Express {
    const { webhookLimiter } = freshRateLimitModule();
    const app = express();
    app.post("/webhooks/whatsapp", webhookLimiter, (_req, res) => res.sendStatus(200));
    return app;
  }

  it("permite requisições dentro do limite (100 por minuto)", async () => {
    const app = buildApp();
    for (let i = 0; i < 100; i++) {
      const res = await request(app).post("/webhooks/whatsapp").send({});
      expect(res.status).toBe(200);
    }
  }, 20000);

  it("retorna 429 na 101ª requisição dentro da janela", async () => {
    const app = buildApp();
    for (let i = 0; i < 100; i++) {
      await request(app).post("/webhooks/whatsapp").send({});
    }
    const res = await request(app).post("/webhooks/whatsapp").send({});
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: expect.any(String) });
  }, 20000);
});

describe("importLimiter", () => {
  function buildApp(): Express {
    const { importLimiter } = freshRateLimitModule();
    const app = express();
    // Simula requireAuth: popula req.user antes do limiter, como acontece de fato em
    // routes/imports.ts (router.use(requireAuth) roda antes de qualquer rota).
    app.use((req, _res, next) => {
      req.user = { id: "user-1", tenantId: "tenant-1", role: "OPERATOR", email: "a@a.com" };
      next();
    });
    app.post("/api/imports/csv", importLimiter, (_req, res) => res.json({ ok: true }));
    return app;
  }

  it("permite requisições dentro do limite (20 a cada 10min) para o mesmo usuário", async () => {
    const app = buildApp();
    for (let i = 0; i < 20; i++) {
      const res = await request(app).post("/api/imports/csv").send({});
      expect(res.status).toBe(200);
    }
  });

  it("retorna 429 na 21ª requisição do mesmo usuário", async () => {
    const app = buildApp();
    for (let i = 0; i < 20; i++) {
      await request(app).post("/api/imports/csv").send({});
    }
    const res = await request(app).post("/api/imports/csv").send({});
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: expect.any(String) });
  });

  it("mantém orçamentos separados por usuário (keyGenerator usa req.user.id)", async () => {
    const { importLimiter } = freshRateLimitModule();
    const app = express();
    let nextUserId = "user-a";
    app.use((req, _res, next) => {
      req.user = { id: nextUserId, tenantId: "tenant-1", role: "OPERATOR", email: "a@a.com" };
      next();
    });
    app.post("/api/imports/csv", importLimiter, (_req, res) => res.json({ ok: true }));

    for (let i = 0; i < 20; i++) {
      const res = await request(app).post("/api/imports/csv").send({});
      expect(res.status).toBe(200);
    }
    // user-a esgotou o orçamento
    const blocked = await request(app).post("/api/imports/csv").send({});
    expect(blocked.status).toBe(429);

    // user-b, mesmo IP/processo, ainda tem orçamento próprio
    nextUserId = "user-b";
    const allowed = await request(app).post("/api/imports/csv").send({});
    expect(allowed.status).toBe(200);
  });
});

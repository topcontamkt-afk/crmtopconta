import express from "express";
import request from "supertest";

const findEvent = jest.fn();
const findTemplate = jest.fn();
const updateEvent = jest.fn();
jest.mock("../config/db", () => ({
  prisma: {
    messageEvent: { findUnique: (...a: any[]) => findEvent(...a), update: (...a: any[]) => updateEvent(...a) },
    messageTemplate: { findUnique: (...a: any[]) => findTemplate(...a) },
  },
}));
jest.mock("../config/tenantGuard", () => ({ withCrossTenantAccess: (fn: () => Promise<any>) => fn() }));

import router from "./trackedLinks";
import { makeToken } from "../services/trackedLinks";

const EVENT = "7f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const DESTINO = "https://topconta.onelink.me/tLP0/uwl4jeer";
const template = { quickReplies: ["SAIR"], buttons: [{ type: "URL", text: "Usar o limite", url: DESTINO, tracked: true }] };
const CELULAR = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36";

const app = express();
app.use("/r", router);

beforeAll(() => {
  process.env.JWT_SECRET = "segredo-de-teste";
});
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.LINK_FALLBACK_URL;
  findEvent.mockResolvedValue({ id: EVENT, campaign: { template } });
  findTemplate.mockResolvedValue(template);
  updateEvent.mockResolvedValue({});
});

describe("GET /r/:token", () => {
  it("redireciona para o destino e registra o primeiro clique", async () => {
    findEvent.mockResolvedValueOnce({ id: EVENT, campaign: { template } }).mockResolvedValueOnce({ clickedAt: null });
    const r = await request(app).get(`/r/${makeToken("e", EVENT, 1)}`).set("User-Agent", CELULAR);
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe(DESTINO);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(updateEvent).toHaveBeenCalledTimes(1);
    const data = updateEvent.mock.calls[0][0].data;
    expect(data.clickCount).toEqual({ increment: 1 });
    expect(data.clickedAt).toBeInstanceOf(Date);
  });

  it("clique repetido soma, sem mexer na data do primeiro", async () => {
    findEvent.mockResolvedValueOnce({ id: EVENT, campaign: { template } }).mockResolvedValueOnce({ clickedAt: new Date("2026-10-10T10:00:00Z") });
    await request(app).get(`/r/${makeToken("e", EVENT, 1)}`).set("User-Agent", CELULAR);
    const data = updateEvent.mock.calls[0][0].data;
    expect(data.clickCount).toEqual({ increment: 1 });
    expect(data.clickedAt).toBeUndefined();
  });

  it("prévia do WhatsApp e HEAD redirecionam sem contar", async () => {
    const token = makeToken("e", EVENT, 1);
    const bot = await request(app).get(`/r/${token}`).set("User-Agent", "WhatsApp/2.23.20.0 A");
    expect(bot.status).toBe(302);
    const head = await request(app).head(`/r/${token}`).set("User-Agent", CELULAR);
    expect(head.status).toBe(302);
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it("código de teste/Inbox (tipo n) só redireciona", async () => {
    const r = await request(app).get(`/r/${makeToken("n", EVENT, 1)}`).set("User-Agent", CELULAR);
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe(DESTINO);
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it("código inválido, adulterado ou de botão inexistente não redireciona para lugar nenhum", async () => {
    expect((await request(app).get("/r/lixo")).status).toBe(404);
    const t = makeToken("e", EVENT, 1);
    expect((await request(app).get(`/r/${t.slice(0, 10)}Z${t.slice(11)}`)).status).toBe(404);
    expect((await request(app).get(`/r/${makeToken("e", EVENT, 5)}`)).status).toBe(404);
    findEvent.mockResolvedValueOnce(null);
    expect((await request(app).get(`/r/${makeToken("e", EVENT, 1)}`)).status).toBe(404);
  });

  it("com LINK_FALLBACK_URL, o código inválido vai para o link padrão", async () => {
    process.env.LINK_FALLBACK_URL = DESTINO;
    const r = await request(app).get("/r/lixo");
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe(DESTINO);
  });

  it("falha ao gravar o clique não impede o redirecionamento", async () => {
    findEvent.mockResolvedValueOnce({ id: EVENT, campaign: { template } }).mockResolvedValueOnce({ clickedAt: null });
    updateEvent.mockRejectedValueOnce(new Error("banco fora"));
    const r = await request(app).get(`/r/${makeToken("e", EVENT, 1)}`).set("User-Agent", CELULAR);
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe(DESTINO);
  });
});

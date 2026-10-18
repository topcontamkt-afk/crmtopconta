/**
 * Prova da correção LGPD 05-07: o acesso por área não pode ser contornado pela caixa da URL (o Express casa
 * rotas sem diferenciar maiúsculas) e usuário desativado com JWT ainda válido é barrado em qualquer rota.
 * Sobe um Express de verdade com o middleware e uma rota de clientes, com Prisma mockado.
 */
const findFirst = jest.fn();
jest.mock("../config/db", () => ({ prisma: { user: { findFirst: (...a: any[]) => findFirst(...a) } } }));
jest.mock("../config/env", () => ({ env: { JWT_SECRET: "segredo-de-teste" } }));
jest.mock("../config/tenantGuard", () => ({ runWithTenantContextAsync: (_t: string, fn: () => Promise<unknown>) => fn() }));

import express from "express";
import jwt from "jsonwebtoken";
import type { AddressInfo } from "net";
import { areaAccess, invalidateAccessCache } from "./areaAccess";

const token = (sub: string) => jwt.sign({ sub, tenantId: "t1", role: "OPERATOR", email: "x@y.z" }, "segredo-de-teste");

function app() {
  const a = express();
  a.use("/api", areaAccess);
  const clients = express.Router();
  clients.get("/export.csv", (_q, r) => { r.send("EXPORTOU"); });
  a.use("/api/clients", clients);
  a.get("/api/tenant/settings", (_q, r) => { r.send("SETTINGS"); });
  return a;
}

async function get(path: string, sub: string) {
  const srv = app().listen(0);
  try {
    const { port } = srv.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${token(sub)}` } });
    return { status: res.status, body: await res.text() };
  } finally {
    srv.close();
  }
}

describe("areaAccess (LGPD 05-07)", () => {
  beforeEach(() => {
    findFirst.mockReset();
    invalidateAccessCache();
  });

  it("usuário só de Inbox não exporta clientes, nem trocando a caixa ou codificando a URL", async () => {
    findFirst.mockResolvedValue({ role: "OPERATOR", active: true, areasRestritas: true, areas: ["inbox"] });
    for (const p of ["/api/clients/export.csv", "/api/CLIENTS/export.csv", "/api/Clients/Export.csv", "/api/%63lients/export.csv"]) {
      const r = await get(p, "u-inbox");
      expect({ p, status: r.status }).toEqual({ p, status: 403 });
    }
  });

  it("usuário com a área de clientes continua exportando", async () => {
    findFirst.mockResolvedValue({ role: "OPERATOR", active: true, areasRestritas: true, areas: ["clients"] });
    const r = await get("/api/CLIENTS/export.csv", "u-clientes");
    expect(r.status).toBe(200);
    expect(r.body).toBe("EXPORTOU");
  });

  it("usuário desativado com JWT válido é barrado também em rota sem área", async () => {
    findFirst.mockResolvedValue({ role: "ADMIN", active: false, areasRestritas: false, areas: [] });
    expect((await get("/api/tenant/settings", "u-off")).status).toBe(401);
    expect((await get("/api/CLIENTS/export.csv", "u-off")).status).toBe(401);
  });
});

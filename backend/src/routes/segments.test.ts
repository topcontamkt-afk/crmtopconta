import express from "express";
import request from "supertest";

const db: any = {
  segmentDefinition: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(async ({ data }: any) => ({ id: "s1", ...data })), update: jest.fn() },
  client: { count: jest.fn(async (_a?: any) => 7) },
};
jest.mock("../config/db", () => ({ prisma: db }));
jest.mock("../middleware/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: "u1", tenantId: "t1", role: "ADMIN" };
    next();
  },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

import router from "./segments";

const app = express();
app.use(express.json());
app.use("/segments", router);

beforeEach(() => jest.clearAllMocks());

describe("LGPD 01-03: renda fora dos segmentos", () => {
  it("segmento salvo com filtro de renda vem marcado para a tela avisar que ele é ignorado", async () => {
    db.segmentDefinition.findMany.mockResolvedValue([
      { id: "a", name: "PF1 · base geral", filters: { perfilRenda: ["PF1"] } },
      { id: "b", name: "Natal", filters: { cidade: ["Natal"] } },
    ]);
    const r = await request(app).get("/segments");
    expect(r.body.map((s: any) => s.filtrosIgnorados)).toEqual([["perfilRenda"], []]);
  });

  it("os segmentos prontos de perfil de renda foram desativados (410)", async () => {
    const r = await request(app).post("/segments/presets/perfis-renda");
    expect(r.status).toBe(410);
    expect(db.segmentDefinition.create).not.toHaveBeenCalled();
  });

  it("novo segmento: o filtro de renda enviado por tela antiga é descartado e não entra na contagem", async () => {
    const r = await request(app).post("/segments").send({ name: "X", filters: { operator: "AND", conditions: { perfilRenda: ["PF2"], noTetoLimite: true, cidade: ["Natal"] } } });
    expect(r.status).toBe(201);
    expect(db.segmentDefinition.create.mock.calls[0][0].data.filters).toEqual({ operator: "AND", conditions: { cidade: ["Natal"] } });
    expect(JSON.stringify(db.client.count.mock.calls[0][0].where)).not.toContain("limiteTotal");
  });

  it("filtros simples (formato da tela) são guardados como vieram, menos a renda", async () => {
    const r = await request(app).post("/segments").send({ name: "Y", filters: { cidade: ["Natal"], perfilRenda: ["PF1"] } });
    expect(r.status).toBe(201);
    expect(db.segmentDefinition.create.mock.calls[0][0].data.filters).toEqual({ cidade: ["Natal"] });
    expect(db.client.count.mock.calls[0][0].where).toEqual({ tenantId: "t1", cidade: { in: ["Natal"] } });
  });
});

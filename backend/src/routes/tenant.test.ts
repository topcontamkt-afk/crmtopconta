import express from "express";
import request from "supertest";

const db: any = {
  tenant: { findUnique: jest.fn(), update: jest.fn() },
  client: { count: jest.fn() },
};
jest.mock("../config/db", () => ({ prisma: db }));
jest.mock("../middleware/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: "u1", tenantId: "t1", role: (req.headers["x-role"] as string) || "ADMIN", email: "a@b.c" };
    next();
  },
  requireRole: (...roles: string[]) => (req: any, res: any, next: any) => (roles.includes(req.user.role) ? next() : res.status(403).json({ error: "Sem permissão" })),
}));
jest.mock("../middleware/audit", () => ({ logAudit: jest.fn(async () => undefined) }));

import router, { vencidosWhere } from "./tenant";
import { logAudit } from "../middleware/audit";

const app = express();
app.use(express.json());
app.use("/tenant", router);
const audit = logAudit as jest.Mock;

const atual = {
  id: "t1",
  name: "TopConta",
  baseLegalMarketing: "LEGITIMO_INTERESSE",
  liaVersao: null,
  liaAprovadaEm: null,
  controladorNome: null,
  encarregadoNome: null,
  encarregadoContato: null,
  avisoPrivacidadeUrl: null,
  rodapeOptOut: null,
  retentionDays: 1095,
  retentionBasis: null,
  retentionDaysAfterClosure: null,
  inboxRetentionDays: null,
  mediaRetentionDays: 90,
  correcaoManualVence: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  db.tenant.findUnique.mockResolvedValue(atual);
  db.tenant.update.mockImplementation(async ({ data }: any) => ({ ...atual, ...data }));
  // vencidos: 100 com o prazo atual; 250 com prazo menor
  db.client.count.mockImplementation(async ({ where }: any) => {
    const cutoff: Date = where.OR[0].dataUltimaUtilizacao.lte;
    return Date.now() - cutoff.getTime() > 1000 * 86_400_000 ? 100 : 250;
  });
});

describe("LGPD 03-06: configuração do controlador", () => {
  it("GET devolve a configuração e o rodapé que vai nas mensagens", async () => {
    const r = await request(app).get("/tenant/lgpd").set("x-role", "VIEWER");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ baseLegalMarketing: "LEGITIMO_INTERESSE", rodapeEfetivo: "TopConta: Responda SAIR para não receber mais mensagens.", limitesRetencao: { min: 30, max: 1825 } });
  });

  it("PUT só ADMIN", async () => {
    const r = await request(app).put("/tenant/lgpd").set("x-role", "OPERATOR").send({ controladorNome: "X" });
    expect(r.status).toBe(403);
    expect(db.tenant.update).not.toHaveBeenCalled();
  });

  it("PUT grava e audita só os campos alterados, com de → para", async () => {
    const r = await request(app)
      .put("/tenant/lgpd")
      .send({ baseLegalMarketing: "LEGITIMO_INTERESSE", liaVersao: "LIA v1", liaAprovadaEm: "2026-10-15", controladorNome: "Top Conta Ltda", encarregadoContato: "privacidade@topconta.com.br" });
    expect(r.status).toBe(200);
    const data = db.tenant.update.mock.calls[0][0].data;
    expect(Object.keys(data).sort()).toEqual(["controladorNome", "encarregadoContato", "liaAprovadaEm", "liaVersao"]);
    const d = audit.mock.calls[0][0];
    expect(d.action).toBe("UPDATE_TENANT_LGPD");
    expect(d.details.alterados.controladorNome).toEqual({ de: null, para: "Top Conta Ltda" });
    expect(d.details.alterados.baseLegalMarketing).toBeUndefined();
  });

  it("valida base legal, URL do aviso (https) e rodapé que ensina a parar", async () => {
    expect((await request(app).put("/tenant/lgpd").send({ baseLegalMarketing: "CONTRATO" })).status).toBe(400);
    expect((await request(app).put("/tenant/lgpd").send({ avisoPrivacidadeUrl: "http://x.com/privacidade" })).status).toBe(400);
    expect((await request(app).put("/tenant/lgpd").send({ rodapeOptOut: "TopConta, seu cartão" })).status).toBe(400);
    expect((await request(app).put("/tenant/lgpd").send({ rodapeOptOut: "TopConta. Responda SAIR para sair." })).status).toBe(200);
    expect((await request(app).put("/tenant/lgpd").send({ campoQualquer: 1 })).status).toBe(400);
  });
});

describe("LGPD 04-07: prazo de retenção com limites, fundamento e prévia", () => {
  it("fora de 30–1825 dias é recusado", async () => {
    expect((await request(app).put("/tenant/lgpd").send({ retentionDays: 1, retentionBasis: "Prazo prescricional de 5 anos" })).status).toBe(400);
    expect((await request(app).put("/tenant/lgpd").send({ retentionDays: 36500, retentionBasis: "Prazo prescricional de 5 anos" })).status).toBe(400);
  });

  it("mudar o prazo sem fundamento é recusado", async () => {
    const r = await request(app).put("/tenant/lgpd").send({ retentionDays: 1825 });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("FUNDAMENTO_OBRIGATORIO");
    expect((await request(app).put("/tenant/lgpd").send({ mediaRetentionDays: 30 })).body.code).toBe("FUNDAMENTO_OBRIGATORIO");
  });

  it("aumentar com fundamento: salva", async () => {
    const r = await request(app).put("/tenant/lgpd").send({ retentionDays: 1825, retentionBasis: "Prazo prescricional do CDC (5 anos)" });
    expect(r.status).toBe(200);
    expect(db.tenant.update.mock.calls[0][0].data).toMatchObject({ retentionDays: 1825, retentionBasis: "Prazo prescricional do CDC (5 anos)" });
  });

  it("reduzir com clientes a mais para anonimizar: pede confirmação com a prévia; confirmado, salva", async () => {
    const body = { retentionDays: 365, retentionBasis: "Finalidade de marketing encerra em 1 ano" };
    const r = await request(app).put("/tenant/lgpd").send(body);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "CONFIRMAR_REDUCAO", previa: { vencidosHoje: 100, vencidosComNovo: 250, aMais: 150 } });
    expect(db.tenant.update).not.toHaveBeenCalled();

    const ok = await request(app).put("/tenant/lgpd").send({ ...body, confirmarReducao: true });
    expect(ok.status).toBe(200);
    expect(audit.mock.calls[0][0].details.alterados.retentionDays).toEqual({ de: 1095, para: 365 });
  });

  it("prévia: só contagem, só ADMIN", async () => {
    expect((await request(app).get("/tenant/lgpd/previa-retencao?dias=365").set("x-role", "OPERATOR")).status).toBe(403);
    const r = await request(app).get("/tenant/lgpd/previa-retencao?dias=365");
    expect(r.body).toEqual({ prazoAtual: 1095, prazoNovo: 365, vencidosHoje: 100, vencidosComNovo: 250, aMais: 150 });
    expect((await request(app).get("/tenant/lgpd/previa-retencao?dias=5")).status).toBe(400);
  });

  it("PUT /settings não muda mais o prazo (só pela tela LGPD, com fundamento)", async () => {
    expect((await request(app).put("/tenant/settings").send({ retentionDays: 30 })).status).toBe(400);
    expect((await request(app).put("/tenant/settings").send({ retentionDays: 1095, maxMsgsPerMinute: 100 })).status).toBe(200);
    expect(db.tenant.update.mock.calls[0][0].data).toEqual({ maxMsgsPerMinute: 100 });
  });

  it("o critério da prévia é o da rotina de retenção (inatividade ou cadastro antigo sem uso, não anonimizado)", () => {
    const agora = new Date("2026-10-18T00:00:00Z");
    const w: any = vencidosWhere("t1", 30, agora);
    expect(w).toMatchObject({ tenantId: "t1", anonymizedAt: null });
    expect(w.OR[0].dataUltimaUtilizacao.lte).toEqual(new Date("2026-09-18T00:00:00Z"));
  });
});

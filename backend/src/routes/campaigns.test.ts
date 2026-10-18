import express from "express";
import request from "supertest";

const db: any = {
  tenant: { findUnique: jest.fn() },
  messageTemplate: { findFirst: jest.fn() },
  segmentDefinition: { findFirst: jest.fn() },
  client: { count: jest.fn(async (_a?: any) => 3) },
  campaign: { create: jest.fn(async ({ data }: any) => ({ id: "camp1", ...data })), findFirst: jest.fn() },
  campaignRecipient: { createMany: jest.fn(), findMany: jest.fn(async (_a?: any): Promise<any[]> => []) },
  messageEvent: { createMany: jest.fn(), findMany: jest.fn(async (_a?: any): Promise<any[]> => []) },
};
jest.mock("../config/db", () => ({ prisma: db, tenantRaw: { query: jest.fn(), execute: jest.fn() } }));
jest.mock("../middleware/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: "u1", tenantId: "t1", role: (req.headers["x-role"] as string) || "OPERATOR", email: "op@topconta.demo" };
    next();
  },
  requireRole: (...roles: string[]) => (req: any, res: any, next: any) => (roles.includes(req.user.role) ? next() : res.status(403).json({ error: "Sem permissão" })),
}));
jest.mock("../middleware/audit", () => ({ logAudit: jest.fn(async () => undefined) }));
const enqueueCampaign = jest.fn();
jest.mock("../services/campaignQueue", () => ({ buildAudience: jest.fn(), enqueueCampaign: (...a: any[]) => enqueueCampaign(...a), processQueueBatch: jest.fn(), sendTestMessages: jest.fn() }));
const prepareManual = jest.fn();
jest.mock("../services/manualCampaign", () => ({ prepareManual: (...a: any[]) => prepareManual(...a), linkRecipients: jest.fn() }));
jest.mock("../services/campaignWizard", () => ({ validateWizard: jest.fn() }));
jest.mock("../services/campaignResults", () => ({ ...jest.requireActual("../services/campaignResults"), loadCampaignEvaluations: jest.fn(async () => []) }));

import router from "./campaigns";
import { logAudit } from "../middleware/audit";
import { SEM_BASE_LEGAL } from "../services/baseLegal";

const app = express();
app.use(express.json());
app.use("/campaigns", router);
const audit = logAudit as jest.Mock;

const LI = { baseLegalMarketing: "LEGITIMO_INTERESSE" };
const template = { id: "tp1", body: "Olá {{nome}}", status: "APROVADO" };
const rows = [{ nome: "Ana", telefone: "84999998888" }];
const manual = (over: any = {}) => ({ name: "Lista", templateId: "tp1", rows, consentimento: true, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  db.tenant.findUnique.mockResolvedValue(LI);
  db.messageTemplate.findFirst.mockResolvedValue(template);
});

describe("LGPD 02-01: campanha sem base legal declarada não é criada", () => {
  it("POST /campaigns: 409 com a mensagem de Configurações → LGPD", async () => {
    db.tenant.findUnique.mockResolvedValue({ baseLegalMarketing: null });
    const r = await request(app).post("/campaigns").send({ name: "C", channel: "WHATSAPP", templateId: "tp1" });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: SEM_BASE_LEGAL, code: "SEM_BASE_LEGAL" });
    expect(db.campaign.create).not.toHaveBeenCalled();
  });

  it("POST /campaigns: grava a base vigente na campanha e na auditoria; o público estimado exclui bloqueados", async () => {
    const r = await request(app).post("/campaigns").send({ name: "C", channel: "WHATSAPP", templateId: "tp1" });
    expect(r.status).toBe(201);
    expect(db.campaign.create.mock.calls[0][0].data.baseLegal).toBe("LEGITIMO_INTERESSE");
    expect(audit.mock.calls[0][0].details.baseLegal).toBe("LEGITIMO_INTERESSE");
    expect(db.client.count.mock.calls[0][0].where).toMatchObject({ bloqueadoLgpdAt: null });
  });

  it("POST /campaigns/manual: 409 sem base", async () => {
    db.tenant.findUnique.mockResolvedValue({ baseLegalMarketing: null });
    const r = await request(app).post("/campaigns/manual").send(manual());
    expect(r.status).toBe(409);
    expect(prepareManual).not.toHaveBeenCalled();
  });

  it("POST /:id/schedule: a fila recusa (sem base) vira 409", async () => {
    db.campaign.findFirst.mockResolvedValue({ id: "camp1" });
    enqueueCampaign.mockResolvedValue({ audienceSize: 0, queued: 0, control: 0, skippedDedupe: 0, bloqueado: SEM_BASE_LEGAL });
    const r = await request(app).post("/campaigns/camp1/schedule");
    expect(r.status).toBe(409);
    expect(r.body.error).toBe(SEM_BASE_LEGAL);
  });
});

describe("LGPD 02-02: lista manual com quem não é cliente exige o consentimento declarado", () => {
  it("com não clientes e sem a origem: 400 CONSENTIMENTO_OBRIGATORIO, nada criado", async () => {
    prepareManual.mockResolvedValue({ template, enviar: [{ clientId: "c1" }, { clientId: null }], daBase: 1, rejected: [] });
    const r = await request(app).post("/campaigns/manual").send(manual());
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: "CONSENTIMENTO_OBRIGATORIO", foraDaBase: 1 });
    expect(db.campaign.create).not.toHaveBeenCalled();

    const curta = await request(app).post("/campaigns/manual").send(manual({ consentimentoOrigem: "site" }));
    expect(curta.status).toBe(400);
  });

  it("com a origem: grava origem, quem declarou (usuário logado) e quando", async () => {
    prepareManual.mockResolvedValue({ template, enviar: [{ clientId: null, nome: "X", telefone: "+5584999998888" }], daBase: 0, rejected: [] });
    const r = await request(app).post("/campaigns/manual").send(manual({ consentimentoOrigem: "Formulário do site, aceite de WhatsApp, out/2026" }));
    expect(r.status).toBe(201);
    const data = db.campaign.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ baseLegal: "LEGITIMO_INTERESSE", consentimentoOrigem: "Formulário do site, aceite de WhatsApp, out/2026", consentimentoPor: "op@topconta.demo" });
    expect(data.consentimentoEm).toBeInstanceOf(Date);
    expect(audit.mock.calls[0][0].details).toMatchObject({ consentimentoDeclarado: true });
  });

  it("lista só de clientes segue a base do tenant (sem declaração)", async () => {
    prepareManual.mockResolvedValue({ template, enviar: [{ clientId: "c1" }], daBase: 1, rejected: [] });
    const r = await request(app).post("/campaigns/manual").send(manual());
    expect(r.status).toBe(201);
    const data = db.campaign.create.mock.calls[0][0].data;
    expect(data.baseLegal).toBe("LEGITIMO_INTERESSE");
    expect(data.consentimentoOrigem).toBeUndefined();
  });
});

describe("LGPD 05-01: telefone mascarado no relatório nominal e no CSV", () => {
  const TEL = "+5584999998888";
  beforeEach(() => {
    db.campaign.findFirst.mockResolvedValue({ id: "camp1", manual: false });
    db.messageEvent.findMany.mockResolvedValue([
      { id: "e1", status: "ENVIADO", variant: "A", provider: "mock", cost: 0, sentAt: null, clickedAt: null, clickCount: 0, client: { nome: "Ana", telefone: TEL, cidade: "Natal" }, recipient: null },
    ]);
  });

  it("GET export.csv sai mascarado e audita sem telefone completo", async () => {
    const r = await request(app).get("/campaigns/camp1/report/export.csv");
    expect(r.status).toBe(200);
    expect(r.text).toContain("*********8888");
    expect(r.text).not.toContain(TEL);
    expect(audit.mock.calls[0][0].details).toMatchObject({ telefoneCompleto: false, count: 1 });
  });

  it("GET com ?completo é recusado (motivo não vai na URL)", async () => {
    const r = await request(app).get("/campaigns/camp1/report/export.csv?completo=1&motivo=teste").set("x-role", "ADMIN");
    expect(r.status).toBe(400);
  });

  it("completo: OPERATOR não pode; ADMIN precisa de motivo; com motivo sai completo e auditado", async () => {
    expect((await request(app).post("/campaigns/camp1/report/export.csv").send({ completo: true, motivo: "conferência" })).status).toBe(403);
    expect((await request(app).post("/campaigns/camp1/report/export.csv").set("x-role", "ADMIN").send({ completo: true })).status).toBe(400);
    const r = await request(app).post("/campaigns/camp1/report/export.csv").set("x-role", "ADMIN").send({ completo: true, motivo: "pedido do titular 123" });
    expect(r.status).toBe(200);
    expect(r.text).toContain(TEL);
    expect(audit.mock.calls.at(-1)[0].details).toMatchObject({ telefoneCompleto: true, motivo: "pedido do titular 123" });
  });

  it("/destinatarios mostra o telefone mascarado", async () => {
    db.campaignRecipient.findMany.mockResolvedValue([{ id: "r1", nome: "Ana", telefone: TEL, clientId: null, limiteDisponivel: null, messageEvents: [] }]);
    const r = await request(app).get("/campaigns/camp1/destinatarios");
    expect(r.status).toBe(200);
    expect(r.body.destinatarios[0].telefone).toBe("*********8888");
  });
});

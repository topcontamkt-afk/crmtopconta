/**
 * Webhook de SMS: autenticação para todo provedor (LGPD 05-05) e descadastro por resposta SMS (LGPD 02-04).
 */
import express from "express";
import request from "supertest";

const channelFindFirst = jest.fn();
const eventFindFirst = jest.fn();
const eventUpdate = jest.fn();
const sheetFindFirst = jest.fn();
const sheetCreate = jest.fn();
jest.mock("../config/db", () => ({
  prisma: {
    channelConfig: { findFirst: (...a: any[]) => channelFindFirst(...a) },
    sheetConnection: { findFirst: (...a: any[]) => sheetFindFirst(...a), create: (...a: any[]) => sheetCreate(...a), update: jest.fn() },
    messageEvent: { findFirst: (...a: any[]) => eventFindFirst(...a), update: (...a: any[]) => eventUpdate(...a) },
  },
}));
jest.mock("../config/env", () => ({ env: { TWILIO_AUTH_TOKEN: "tok-do-ambiente" } }));
jest.mock("../config/tenantGuard", () => ({
  withCrossTenantAccess: (fn: () => Promise<any>) => fn(),
  runWithTenantContextAsync: (_t: string, fn: () => Promise<any>) => fn(),
}));
jest.mock("../middleware/auth", () => ({
  requireAuth: (q: any, _r: any, n: any) => {
    q.user = { id: "u1", tenantId: "t1", role: "ADMIN" };
    n();
  },
  requireRole: () => (_q: any, _r: any, n: any) => n(),
}));
jest.mock("../middleware/rateLimit", () => ({ webhookLimiter: (_q: any, _r: any, n: any) => n() }));
jest.mock("../middleware/audit", () => ({ logAudit: jest.fn(async () => undefined) }));
jest.mock("../services/biExport", () => ({ exportTenantSummaryToSheet: jest.fn() }));
jest.mock("../services/privacy", () => ({ registrarOptOutTelefone: jest.fn(async () => ({ clientIds: ["c1"], telefoneMasked: "*********8888" })) }));

import router from "./integrations";
import { computeTwilioSignature } from "../services/webhookAuth";
import { encryptSecret } from "../services/crypto";
import { registrarOptOutTelefone } from "../services/privacy";
import { logAudit } from "../middleware/audit";

const app = express();
app.use(express.json());
app.use("/api/integrations", router);

const HOST = "api.teste.com";
const SEGREDO = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

beforeAll(() => {
  process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");
});
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.PLATFORM_DEFAULT_TENANT_ID;
  eventFindFirst.mockResolvedValue({ id: "ev1", status: "ENVIADO", deliveredAt: null, respondedAt: null, error: null });
  eventUpdate.mockResolvedValue({});
});

const postForm = (path: string, form: Record<string, string>, headers: Record<string, string> = {}) => {
  let r = request(app).post(path).type("form").set("X-Forwarded-Proto", "https").set("X-Forwarded-Host", HOST);
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return r.send(form);
};
const assinatura = (path: string, form: Record<string, string>, token: string) => computeTwilioSignature(`https://${HOST}${path}`, form, token);

describe("POST /webhooks/sms/:provider (rota antiga)", () => {
  it("Zenvia (sem assinatura) é recusada com 401 e nada é gravado — antes passava sem verificação", async () => {
    const r = await request(app).post("/api/integrations/webhooks/sms/zenvia").send({ sid: "Z1", status: "failed" });
    expect(r.status).toBe(401);
    expect(eventFindFirst).not.toHaveBeenCalled();
    expect(eventUpdate).not.toHaveBeenCalled();
  });

  it("qualquer outro provedor inventado também é recusado", async () => {
    const r = await request(app).post("/api/integrations/webhooks/sms/qualquer").send({ sid: "Z1", status: "delivered" });
    expect(r.status).toBe(401);
  });

  it("Twilio sem assinatura válida: 401", async () => {
    const r = await postForm("/api/integrations/webhooks/sms/twilio", { MessageSid: "SM1", MessageStatus: "delivered" }, { "X-Twilio-Signature": "falsa" });
    expect(r.status).toBe(401);
    expect(eventUpdate).not.toHaveBeenCalled();
  });

  it("Twilio assinada com o token do ambiente: aplica o status", async () => {
    const path = "/api/integrations/webhooks/sms/twilio";
    const form = { MessageSid: "SM1", MessageStatus: "delivered" };
    const r = await postForm(path, form, { "X-Twilio-Signature": assinatura(path, form, "tok-do-ambiente") });
    expect(r.status).toBe(200);
    expect(eventUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "ENTREGUE" }) }));
  });
});

describe("POST /webhooks/sms/:provider/:configId/:secret (por canal)", () => {
  const zenvia = { id: "cfg-z", tenantId: "t1", channel: "SMS", provider: "zenvia", webhookSecret: SEGREDO, credentials: {} };

  it("segredo errado ou canal inexistente: 401", async () => {
    channelFindFirst.mockResolvedValueOnce(zenvia);
    const r1 = await request(app).post("/api/integrations/webhooks/sms/zenvia/cfg-z/errado").send({ sid: "Z1", status: "failed" });
    expect(r1.status).toBe(401);
    channelFindFirst.mockResolvedValueOnce(null);
    const r2 = await request(app).post(`/api/integrations/webhooks/sms/zenvia/cfg-x/${SEGREDO}`).send({ sid: "Z1", status: "failed" });
    expect(r2.status).toBe(401);
    expect(eventUpdate).not.toHaveBeenCalled();
  });

  it("canal sem segredo gravado recusa tudo", async () => {
    channelFindFirst.mockResolvedValueOnce({ ...zenvia, webhookSecret: null });
    const r = await request(app).post("/api/integrations/webhooks/sms/zenvia/cfg-z").set("X-Webhook-Secret", SEGREDO).send({ sid: "Z1", status: "failed" });
    expect(r.status).toBe(401);
  });

  it("Zenvia com o segredo (na URL ou no cabeçalho): status só no tenant do canal", async () => {
    channelFindFirst.mockResolvedValue(zenvia);
    const r = await request(app).post(`/api/integrations/webhooks/sms/zenvia/cfg-z/${SEGREDO}`).send({ type: "MESSAGE_STATUS", messageId: "Z1", messageStatus: { code: "DELIVERED" } });
    expect(r.status).toBe(200);
    expect(eventFindFirst).toHaveBeenCalledWith({ where: { providerMsgId: "Z1", campaign: { tenantId: "t1" } } });
    const h = await request(app).post("/api/integrations/webhooks/sms/zenvia/cfg-z").set("X-Webhook-Secret", SEGREDO).send({ type: "MESSAGE_STATUS", messageId: "Z1", messageStatus: { code: "DELIVERED" } });
    expect(h.status).toBe(200);
  });

  it("titular responde SAIR por SMS (Zenvia): grava supressão/opt-out do telefone com canal SMS e auditoria", async () => {
    channelFindFirst.mockResolvedValue(zenvia);
    const r = await request(app)
      .post(`/api/integrations/webhooks/sms/zenvia/cfg-z/${SEGREDO}`)
      .send({ type: "MESSAGE", direction: "IN", message: { id: "Z9", from: "5584999998888", to: "TOP", contents: [{ type: "text", text: "Sair" }] } });
    expect(r.status).toBe(200);
    expect(registrarOptOutTelefone).toHaveBeenCalledWith(expect.anything(), "t1", expect.objectContaining({ telefone: "5584999998888", canal: "SMS" }));
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", action: "OPT_OUT_SMS" }));
  });

  it("Twilio por canal: exige o segredo E a assinatura com o Auth Token do canal; PARAR descadastra e responde TwiML vazio", async () => {
    const twilio = { id: "cfg-t", tenantId: "t1", channel: "SMS", provider: "twilio", webhookSecret: SEGREDO, credentials: encryptSecret({ accountSid: "AC1", authToken: "tok-do-canal", fromNumber: "+15550000000" }) };
    channelFindFirst.mockResolvedValue(twilio);
    const path = `/api/integrations/webhooks/sms/twilio/cfg-t/${SEGREDO}`;
    const form = { MessageSid: "SM9", SmsStatus: "received", From: "+5584999998888", To: "+15550000000", Body: "PARAR" };

    const semAssinatura = await postForm(path, form, { "X-Twilio-Signature": assinatura(path, form, "tok-do-ambiente") });
    expect(semAssinatura.status).toBe(401);
    expect(registrarOptOutTelefone).not.toHaveBeenCalled();

    const ok = await postForm(path, form, { "X-Twilio-Signature": assinatura(path, form, "tok-do-canal") });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe("<Response></Response>");
    expect(registrarOptOutTelefone).toHaveBeenCalledWith(expect.anything(), "t1", expect.objectContaining({ telefone: "+5584999998888", canal: "SMS" }));
  });

  it("mensagem comum por SMS não descadastra", async () => {
    channelFindFirst.mockResolvedValue(zenvia);
    await request(app)
      .post(`/api/integrations/webhooks/sms/zenvia/cfg-z/${SEGREDO}`)
      .send({ type: "MESSAGE", direction: "IN", message: { from: "5584999998888", contents: [{ type: "text", text: "Qual meu limite?" }] } });
    expect(registrarOptOutTelefone).not.toHaveBeenCalled();
  });
});

describe("PUT /sheets: planilha de outro controlador (LGPD 06-02)", () => {
  const corpo = { sheetId: "planilha-1", columnMapping: { nome: "Nome" } };
  beforeEach(() => {
    sheetFindFirst.mockReset();
    sheetCreate.mockReset();
    (logAudit as jest.Mock).mockClear();
  });

  it("recusa com 409 a planilha já ativa em outro tenant, sem gravar", async () => {
    sheetFindFirst.mockImplementation(async (a: any) => (a.where.tenantId?.not ? { id: "s-outro" } : null));
    const r = await request(app).put("/api/integrations/sheets").send(corpo);
    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe("PLANILHA_EM_OUTRO_CONTROLADOR");
    expect(sheetFindFirst.mock.calls[0][0].where).toMatchObject({ sheetId: "planilha-1", active: true, tenantId: { not: "t1" } });
    expect(sheetCreate).not.toHaveBeenCalled();
  });

  it("aceita planilha livre e audita o sheetId", async () => {
    sheetFindFirst.mockResolvedValue(null);
    sheetCreate.mockImplementation(async ({ data }: any) => ({ id: "s1", ...data }));
    const r = await request(app).put("/api/integrations/sheets").send(corpo);
    expect(r.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "CONFIGURE_SHEETS_CONNECTION", details: expect.objectContaining({ sheetId: "planilha-1" }) }));
  });
});

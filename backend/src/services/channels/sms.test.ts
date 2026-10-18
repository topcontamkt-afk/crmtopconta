import { isSmsOptOut, parseSmsWebhook, smsWebhookSecretOk } from "./sms";

describe("parseSmsWebhook", () => {
  it("Twilio: status de entrega", () => {
    expect(parseSmsWebhook("twilio", { MessageSid: "SM1", MessageStatus: "delivered", From: "+15550000000", To: "+5584999998888" })).toEqual([
      { kind: "status", providerMsgId: "SM1", status: "delivered" },
    ]);
  });
  it("Twilio: mensagem recebida do titular (SmsStatus=received)", () => {
    expect(parseSmsWebhook("twilio", { MessageSid: "SM2", SmsStatus: "received", From: "+5584999998888", To: "+15550000000", Body: "PARAR" })).toEqual([
      { kind: "inbound", providerMsgId: "SM2", from: "+5584999998888", to: "+15550000000", body: "PARAR" },
    ]);
  });
  it("Zenvia v2: status e mensagem recebida", () => {
    expect(parseSmsWebhook("zenvia", { type: "MESSAGE_STATUS", messageId: "Z1", messageStatus: { code: "NOT_DELIVERED" } })).toEqual([{ kind: "status", providerMsgId: "Z1", status: "failed" }]);
    expect(
      parseSmsWebhook("zenvia", { type: "MESSAGE", direction: "IN", message: { id: "Z2", from: "5584999998888", to: "TOPCONTA", contents: [{ type: "text", text: "Sair" }] } })
    ).toEqual([{ kind: "inbound", providerMsgId: "Z2", from: "5584999998888", to: "TOPCONTA", body: "Sair" }]);
  });
  it("formato antigo { sid, status } continua valendo para status; corpo vazio não gera evento", () => {
    expect(parseSmsWebhook("zenvia", { sid: "X", status: "delivered" })).toEqual([{ kind: "status", providerMsgId: "X", status: "delivered" }]);
    expect(parseSmsWebhook("zenvia", {})).toEqual([]);
  });
});

describe("isSmsOptOut (LGPD 02-04)", () => {
  it.each(["STOP", "stop", "Parar", "SAIR", "cancelar", "END", "Não quero mais receber", "me tira dessa lista"])("%s descadastra", (t) => {
    expect(isSmsOptOut(t)).toBe(true);
  });
  it.each(["Qual meu limite?", "ok", "", null])("%s não", (t) => {
    expect(isSmsOptOut(t as any)).toBe(false);
  });
});

describe("smsWebhookSecretOk (LGPD 05-05)", () => {
  it("só aceita o segredo exato; ausente de qualquer lado é recusado", () => {
    expect(smsWebhookSecretOk("abc123", "abc123")).toBe(true);
    expect(smsWebhookSecretOk("abc124", "abc123")).toBe(false);
    expect(smsWebhookSecretOk("abc1234", "abc123")).toBe(false);
    expect(smsWebhookSecretOk(undefined, "abc123")).toBe(false);
    expect(smsWebhookSecretOk("abc123", null)).toBe(false);
    expect(smsWebhookSecretOk("", "")).toBe(false);
  });
});

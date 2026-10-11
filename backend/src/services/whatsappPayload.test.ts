import { isOptOutMessage, janelaAte, parseWebhookPayload, phoneCandidates, previewOf } from "./whatsappPayload";

const wrap = (value: any) => ({ entry: [{ changes: [{ field: "messages", value }] }] });
const meta = { phone_number_id: "1055" };

describe("parseWebhookPayload", () => {
  it("lê texto, nome do perfil e horário", () => {
    const r = parseWebhookPayload(
      wrap({ metadata: meta, contacts: [{ wa_id: "5584999998888", profile: { name: "Maria" } }], messages: [{ from: "5584999998888", id: "wamid.A", timestamp: "1760000000", type: "text", text: { body: "Oi, quero saber do meu limite" } }] })
    );
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({ phoneNumberId: "1055", waId: "5584999998888", contactName: "Maria", wamid: "wamid.A", type: "text", body: "Oi, quero saber do meu limite" });
    expect(r.messages[0].timestamp.getTime()).toBe(1760000000 * 1000);
  });

  it("lê mídias com legenda, mime e nome do arquivo", () => {
    const r = parseWebhookPayload(
      wrap({
        metadata: meta,
        messages: [
          { from: "55", id: "1", timestamp: "1", type: "image", image: { id: "m1", mime_type: "image/jpeg", caption: "meu contracheque" } },
          { from: "55", id: "2", timestamp: "1", type: "audio", audio: { id: "m2", mime_type: "audio/ogg; codecs=opus" } },
          { from: "55", id: "3", timestamp: "1", type: "document", document: { id: "m3", mime_type: "application/pdf", filename: "extrato.pdf" } },
        ],
      })
    );
    expect(r.messages.map((m) => m.mediaId)).toEqual(["m1", "m2", "m3"]);
    expect(r.messages[0]).toMatchObject({ type: "image", body: "meu contracheque", mediaMime: "image/jpeg" });
    expect(r.messages[2]).toMatchObject({ type: "document", mediaFilename: "extrato.pdf" });
  });

  it("lê resposta de botão e de mensagem interativa", () => {
    const r = parseWebhookPayload(
      wrap({
        metadata: meta,
        messages: [
          { from: "55", id: "1", timestamp: "1", type: "button", button: { text: "Quero saber mais", payload: "p" } },
          { from: "55", id: "2", timestamp: "1", type: "interactive", interactive: { type: "button_reply", button_reply: { title: "Sim" } } },
        ],
      })
    );
    expect(r.messages.map((m) => m.body)).toEqual(["Quero saber mais", "Sim"]);
  });

  it("localização, contato e tipo não suportado viram texto legível, sem inventar conteúdo", () => {
    const r = parseWebhookPayload(
      wrap({
        metadata: meta,
        messages: [
          { from: "55", id: "1", timestamp: "1", type: "location", location: { latitude: -5.8, longitude: -35.2, name: "Natal" } },
          { from: "55", id: "2", timestamp: "1", type: "contacts", contacts: [{}] },
          { from: "55", id: "3", timestamp: "1", type: "unsupported" },
        ],
      })
    );
    expect(r.messages[0].body).toContain("Natal");
    expect(r.messages[1].body).toBe("Contato compartilhado");
    expect(r.messages[2].body).toContain("não suportada");
  });

  it("lê status de envio, inclusive o erro de falha", () => {
    const r = parseWebhookPayload(
      wrap({ metadata: meta, statuses: [{ id: "wamid.X", status: "failed", timestamp: "1760000000", errors: [{ code: 131047, title: "Re-engagement message" }] }, { id: "wamid.Y", status: "read" }] })
    );
    expect(r.statuses).toHaveLength(2);
    expect(r.statuses[0]).toMatchObject({ wamid: "wamid.X", status: "failed", errorText: "131047 Re-engagement message" });
    expect(r.statuses[1].errorText).toBeNull();
  });

  it("ignora lixo sem quebrar", () => {
    expect(parseWebhookPayload(null)).toEqual({ messages: [], statuses: [] });
    expect(parseWebhookPayload({ entry: [{ changes: [{}] }] })).toEqual({ messages: [], statuses: [] });
    expect(parseWebhookPayload(wrap({ metadata: meta, messages: [{ id: "sem-from" }] })).messages).toHaveLength(0);
  });
});

describe("phoneCandidates (nono dígito do Brasil)", () => {
  it("número sem o 9 também procura a forma com 9", () => {
    expect(phoneCandidates("558499998888")).toEqual(["+558499998888", "+5584999998888"]);
  });
  it("número com 9 também procura a forma sem 9", () => {
    expect(phoneCandidates("5584999998888")).toEqual(["+5584999998888", "+558499998888"]);
  });
  it("fixo (não começa com 6-9 depois do DDD) não ganha o 9", () => {
    expect(phoneCandidates("558431231234")).toEqual(["+558431231234"]);
  });
  it("número de outro país fica como veio", () => {
    expect(phoneCandidates("14155550123")).toEqual(["+14155550123"]);
  });
  it("vazio não gera candidatos", () => {
    expect(phoneCandidates("")).toEqual([]);
  });
});

describe("isOptOutMessage", () => {
  it.each(["PARAR", "Sair", "stop", "cancelar", "Parar!", "sair da lista", "PARAR DE RECEBER", "Não quero receber", "nao quero mais receber"])("%s é pedido de descadastro", (t) => {
    expect(isOptOutMessage(t)).toBe(true);
  });
  it.each(["Quero sair do aperto financeiro hoje mesmo", "Oi, tudo bem?", "Qual meu limite?", "", "não paro de receber", "paraiba"])("%s NÃO é", (t) => {
    expect(isOptOutMessage(t)).toBe(false);
  });
});

describe("previewOf e janela de 24 horas", () => {
  it("mídia mostra um rótulo e a legenda", () => {
    expect(previewOf({ type: "image", body: "contracheque" })).toBe("📷 Imagem: contracheque");
    expect(previewOf({ type: "audio", body: null })).toBe("🎤 Áudio");
    expect(previewOf({ type: "text", body: "  olá   mundo " })).toBe("olá mundo");
  });
  it("a janela fecha 24 horas depois da última mensagem do cliente", () => {
    const t = new Date("2026-10-10T12:00:00Z");
    expect(janelaAte(t)!.toISOString()).toBe("2026-10-11T12:00:00.000Z");
    expect(janelaAte(null)).toBeNull();
  });
});

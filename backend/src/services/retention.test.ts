/**
 * Testes com Prisma falso EM MEMÓRIA (não há banco nos testes deste repo). O `where` do Prisma é avaliado por
 * um casador simples (igualdade, in, not, lt/lte/gt, startsWith, OR/AND/NOT; filtros de relação valem como
 * verdadeiros). O AuditLog usa o logAudit e o verifyAuditChain DE VERDADE, para provar que a anonimização tira
 * a PII sem quebrar a cadeia de hash (pendência do Lote 5).
 */

type Row = Record<string, any>;
const store: Record<string, Row[]> = {};
let seq = 0;

function cmp(v: any, cond: any): boolean {
  if (cond === null) return v === null || v === undefined;
  if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
  if (typeof cond !== "object" || Array.isArray(cond)) return v === cond;
  for (const [op, arg] of Object.entries(cond)) {
    const val = v instanceof Date ? v.getTime() : v;
    const a: any = arg instanceof Date ? arg.getTime() : arg;
    if (op === "in" && !(arg as any[]).includes(v)) return false;
    if (op === "notIn" && (arg as any[]).includes(v)) return false;
    if (op === "not" && (arg === null ? v === null || v === undefined : v === arg)) return false;
    if (op === "lt" && !(v != null && val < a)) return false;
    if (op === "lte" && !(v != null && val <= a)) return false;
    if (op === "gt" && !(v != null && val > a)) return false;
    if (op === "gte" && !(v != null && val >= a)) return false;
    if (op === "startsWith" && !(typeof v === "string" && v.startsWith(arg as string))) return false;
  }
  return true;
}
function match(row: Row, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (k === "OR") return (cond as any[]).some((c) => match(row, c));
    if (k === "AND") return (cond as any[]).every((c) => match(row, c));
    if (k === "NOT") return !match(row, cond);
    if (!(k in row) && cond && typeof cond === "object" && !(cond instanceof Date) && !("in" in cond) && !("not" in cond)) return true; // relação
    return cmp(row[k], cond);
  });
}
function model(name: string) {
  const rows = () => (store[name] ??= []);
  const sorted = (list: Row[], orderBy: any) => {
    const ob = Array.isArray(orderBy) ? orderBy[0] : orderBy;
    if (!ob) return list;
    const [k, dir] = Object.entries(ob)[0] as [string, string];
    return [...list].sort((a, b) => ((a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * (dir === "desc" ? -1 : 1)));
  };
  return {
    findMany: jest.fn(async (a: any = {}) => sorted(rows().filter((r) => match(r, a.where)), a.orderBy).slice(0, a.take ?? Infinity).map((r) => ({ ...r }))),
    findFirst: jest.fn(async (a: any = {}) => {
      const r = sorted(rows().filter((x) => match(x, a.where)), a.orderBy)[0];
      return r ? { ...r } : null;
    }),
    findUnique: jest.fn(async (a: any) => rows().find((r) => match(r, a.where)) ?? null),
    create: jest.fn(async ({ data }: any) => {
      const r = { id: `${name}-${++seq}`, createdAt: new Date(), ...data };
      rows().push(r);
      return { ...r };
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const r = rows().find((x) => x.id === where.id);
      if (!r) throw Object.assign(new Error("not found"), { code: "P2025" });
      Object.assign(r, data);
      return { ...r };
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const list = rows().filter((r) => match(r, where));
      list.forEach((r) => Object.assign(r, data));
      return { count: list.length };
    }),
    deleteMany: jest.fn(async ({ where }: any) => {
      const keep = rows().filter((r) => !match(r, where));
      const count = rows().length - keep.length;
      store[name] = keep;
      return { count };
    }),
  };
}

const MODELS = [
  "tenant", "client", "auditLog", "supressaoTitular", "conversation", "waMessage", "waMediaBlob", "campaignRecipient",
  "messageEvent", "accountSnapshot", "movement", "importChange", "notification", "pedidoTitular",
];
const mockPrisma: Record<string, ReturnType<typeof model>> = Object.fromEntries(MODELS.map((m) => [m, model(m)]));
const mockTenantRaw = { execute: jest.fn(async () => 3), query: jest.fn() };
jest.mock("../config/db", () => ({ prisma: mockPrisma, tenantRaw: mockTenantRaw }));

import { prisma } from "../config/db";
import { anonymizeClient, anonymizeContato, ANON_NOME, dadosAnonimizados, inicioDoDiaBrasilia, REDACTED_MARKER, runRetentionSweep } from "./retention";
import { resetAnchorCache, verifyAuditChain } from "./auditIntegrity";
import { logAudit } from "../middleware/audit";
import { runWithTenantContextAsync } from "../config/tenantGuard";
import { phoneHash } from "./privacy";

const SALT = "salt-t1";
const DIA = 86_400_000;
const AGORA = new Date("2026-10-18T12:00:00Z");
const diasAntes = (n: number) => new Date(AGORA.getTime() - n * DIA);

function clienteCompleto(over: Row = {}): Row {
  return {
    id: "c1", tenantId: "t1", nome: "João Silva", telefone: "+5584999998888", cpfHash: "hash-real-do-cpf", cpfMasked: "***.982.247-**",
    documentoTipo: "CPF", externalId: "cartao-123", email: "joao@x.com", cidade: "Natal", diaCicloAbertura: 6,
    dataNascimento: new Date("1980-03-04"), sexo: "M", remuneracaoBruta: 9000, remuneracaoLiquida: 7000, bonus: 100, saldoLiquidoSaque: 50,
    empresaConveniada: "Prefeitura", cidadeEmpresaConveniada: "Natal", vinculoEmpregaticio: "EFETIVO", lotacao: "SEMED", razaoSocial: "Assoc",
    statusValidacaoCadastro: "APROVADO", motivoEncerramento: null, obsEncerramento: null, tags: ["vip"], camposCorrigidos: null, lastImportJobId: "j1",
    dataCadastro: new Date("2020-05-17T10:00:00Z"), dataAberturaConta: new Date("2020-05-20T10:00:00Z"), dataValidadeCartao: new Date("2028-05-31"),
    dataUltimaUtilizacao: diasAntes(2000), ultimoUsoReal: null, encerradoEm: null, createdAt: new Date("2020-05-17T10:00:00Z"),
    limiteTotal: 1500, saldoDisponivel: 400, statusConta: "INATIVO", autorizacaoComunicacao: true, optOutAt: null, anonymizedAt: null, bloqueadoLgpdAt: null,
    ...over,
  };
}

function popular() {
  for (const k of Object.keys(store)) delete store[k];
  store.tenant = [{ id: "t1", cpfSalt: SALT, retentionDays: 1095, retentionDaysAfterClosure: null, inboxRetentionDays: null, mediaRetentionDays: 90 }];
  store.client = [clienteCompleto(), clienteCompleto({ id: "c2", nome: "Maria Souza", telefone: "+5584911112222", cpfHash: "hash-c2", dataUltimaUtilizacao: diasAntes(3) })];
  store.conversation = [
    { id: "conv1", tenantId: "t1", clientId: "c1", waId: "5584999998888", contactName: "João", lastPreview: "Oi", lastMessageAt: diasAntes(10), account: { provider: "ZAPI" } },
    { id: "conv2", tenantId: "t1", clientId: null, waId: "558499998888", contactName: "J", lastPreview: "x", lastMessageAt: diasAntes(10), account: { provider: "META" } },
  ];
  store.waMessage = [
    { id: "m1", tenantId: "t1", conversationId: "conv1", body: "meu cpf é 529...", mediaFilename: "rg.jpg", mediaId: "mid", errorText: null, wamid: "w1", timestamp: diasAntes(10) },
    { id: "m2", tenantId: "t1", conversationId: "conv2", body: "oi", mediaFilename: null, mediaId: null, errorText: null, wamid: "w2", timestamp: diasAntes(10) },
  ];
  store.waMediaBlob = [{ id: "b1", tenantId: "t1", messageId: "m1", createdAt: diasAntes(10) }];
  store.campaignRecipient = [
    { id: "r1", tenantId: "t1", clientId: null, nome: "João da lista", telefone: "+558499998888", cpfHash: null, cpfMasked: null, limiteDisponivel: 300, createdAt: diasAntes(5) },
  ];
  store.messageEvent = [{ id: "e1", clientId: "c1", recipientId: null, providerMsgId: "wamid.X", error: "falhou para +5584999998888", status: "ENTREGUE" }];
  store.accountSnapshot = [{ id: "a1", tenantId: "t1", clientId: "c1" }];
  store.movement = [{ id: "mv1", clientId: "c1" }];
  store.importChange = [
    { id: "ic1", tenantId: "t1", clientId: "c1", before: { nome: "João" }, createdAt: diasAntes(1) },
    { id: "ic2", tenantId: "t1", clientId: "c2", before: { nome: "Maria" }, createdAt: diasAntes(40) },
    { id: "ic3", tenantId: "t1", clientId: "c2", before: { nome: "Maria" }, createdAt: diasAntes(2) },
  ];
  store.notification = [{ id: "n1", tenantId: "t1", relatedType: "Client", relatedId: "c1" }];
  store.pedidoTitular = [
    { id: "p1", tenantId: "t1", clientId: "c1", tipo: "ELIMINACAO", canal: "WHATSAPP", status: "ABERTO", descricao: "João, tel 84 99999-8888, pediu", resposta: "ok João", telefoneMasked: "*********8888" },
    { id: "p2", tenantId: "t1", clientId: "c2", tipo: "ACESSO", canal: "EMAIL", status: "ABERTO", descricao: "Maria pediu cópia", resposta: null, telefoneMasked: null },
  ];
}

const emTenant = <T>(fn: () => Promise<T>) => runWithTenantContextAsync("t1", fn);

beforeEach(() => {
  jest.clearAllMocks();
  resetAnchorCache();
  popular();
});

describe("dadosAnonimizados (LGPD 04-01): campo a campo", () => {
  it("zera identificadores e quase-identificadores, reduz datas ao mês e mantém só agregados", () => {
    const d: any = dadosAnonimizados(clienteCompleto() as any, AGORA);
    expect(d).toMatchObject({ nome: ANON_NOME, telefone: "anon-c1", cpfHash: "anon-c1", cpfMasked: "***.***.***-**", autorizacaoComunicacao: false });
    for (const campo of [
      "documentoTipo", "externalId", "email", "cidade", "diaCicloAbertura", "dataNascimento", "sexo", "remuneracaoBruta", "remuneracaoLiquida",
      "bonus", "saldoLiquidoSaque", "empresaConveniada", "cidadeEmpresaConveniada", "vinculoEmpregaticio", "lotacao", "razaoSocial",
      "statusValidacaoCadastro", "motivoEncerramento", "obsEncerramento", "lastImportJobId",
    ]) {
      expect(d[campo]).toBeNull();
    }
    // etiquetas viraram a tabela ClientTag: anonimizar apaga todas as do cliente
    expect(d.tags).toEqual({ deleteMany: {} });
    expect(d.dataCadastro).toEqual(new Date("2020-05-01T00:00:00Z"));
    expect(d.dataAberturaConta).toEqual(new Date("2020-05-01T00:00:00Z"));
    expect(d.createdAt).toEqual(new Date("2020-05-01T00:00:00Z"));
    expect(d.optOutAt).toEqual(AGORA);
    // agregados ficam (não estão no update)
    for (const campo of ["limiteTotal", "saldoDisponivel", "statusConta"]) expect(d).not.toHaveProperty(campo);
  });

  it("preserva a data do primeiro opt-out e da anonimização anterior", () => {
    const optOut = new Date("2025-01-01T00:00:00Z");
    const d: any = dadosAnonimizados(clienteCompleto({ optOutAt: optOut, anonymizedAt: optOut }) as any, AGORA);
    expect(d.optOutAt).toEqual(optOut);
    expect(d.anonymizedAt).toEqual(optOut);
  });
});

describe("anonymizeClient (LGPD 03-01 / 04-01 / 04-02 / 04-08)", () => {
  it("grava a supressão pelos hashes REAIS antes de sobrescrever (telefone e documento, nunca em claro)", async () => {
    await emTenant(() => anonymizeClient(prisma as any, "t1", "c1", { motivo: "pedido do titular", origem: "PEDIDO_TITULAR", pedidoId: "p1", agora: AGORA }));
    expect(store.supressaoTitular).toHaveLength(1);
    const s = store.supressaoTitular[0];
    expect(s).toMatchObject({ tenantId: "t1", motivo: "ELIMINACAO", docHash: "hash-real-do-cpf", phoneHash: phoneHash(SALT, "+5584999998888") });
    expect(JSON.stringify(s)).not.toContain("99998888");
  });

  it("art. 12: a supressão não aponta para o pedido e guarda só o dia (sem elo do hash do CPF ao cliente)", async () => {
    await emTenant(() => anonymizeClient(prisma as any, "t1", "c1", { motivo: "pedido", origem: "PEDIDO_TITULAR", pedidoId: "p1", agora: AGORA }));
    const s = store.supressaoTitular[0];
    expect(s.pedidoId ?? null).toBeNull();
    expect(s.createdAt).toEqual(new Date("2026-10-18T03:00:00Z")); // meia-noite de Brasília do dia
    expect(inicioDoDiaBrasilia(new Date("2026-10-19T02:59:00Z"))).toEqual(new Date("2026-10-18T03:00:00Z"));
  });

  it("pedidos do titular: texto livre, telefone e vínculo saem; a eliminação aberta dele fica atendida (resposta fixa)", async () => {
    await emTenant(() => anonymizeClient(prisma as any, "t1", "c1", { motivo: "x", origem: "PEDIDO_TITULAR", agora: AGORA }));
    expect(store.pedidoTitular[0]).toMatchObject({
      id: "p1", tipo: "ELIMINACAO", status: "ATENDIDO", respondidoEm: AGORA, clientId: null, descricao: null,
      resposta: "Dados eliminados (anonimização) no CRM.", telefoneMasked: null,
    });
    expect(store.pedidoTitular[1]).toMatchObject({ clientId: "c2", descricao: "Maria pediu cópia" });
  });

  it("número reaproveitado: destinatário com o mesmo telefone e OUTRO CPF não é anonimizado", async () => {
    store.campaignRecipient.push(
      { id: "r2", tenantId: "t1", clientId: null, nome: "Pedro (dono novo do número)", telefone: "+5584999998888", cpfHash: "hash-de-outra-pessoa", cpfMasked: "x", limiteDisponivel: 200, createdAt: diasAntes(1) },
      { id: "r3", tenantId: "t1", clientId: null, nome: "João pelo CPF", telefone: "+5584000000000", cpfHash: "hash-real-do-cpf", cpfMasked: "x", limiteDisponivel: 10, createdAt: diasAntes(1) },
    );
    await emTenant(() => anonymizeClient(prisma as any, "t1", "c1", { motivo: "x", origem: "PEDIDO_TITULAR", agora: AGORA }));
    expect(store.campaignRecipient.find((r) => r.id === "r2")).toMatchObject({ nome: "Pedro (dono novo do número)", telefone: "+5584999998888" });
    expect(store.campaignRecipient.find((r) => r.id === "r3")).toMatchObject({ nome: "Contato anonimizado", telefone: "anon-r3" });
  });

  it("anonimiza o cliente e tudo o que se liga a ele, inclusive conversa e lista sem vínculo pelo número", async () => {
    const r = await emTenant(() => anonymizeClient(prisma as any, "t1", "c1", { motivo: "x", origem: "PEDIDO_TITULAR", agora: AGORA }));
    const c = store.client.find((x) => x.id === "c1")!;
    expect(c).toMatchObject({ nome: ANON_NOME, telefone: "anon-c1", cpfHash: "anon-c1", email: null, externalId: null, dataNascimento: null, anonymizedAt: AGORA });
    // Inbox: número pseudonimizado, nome e prévia fora, texto/arquivo apagados, mídia apagada
    for (const conv of store.conversation) expect(conv).toMatchObject({ waId: `anon-${conv.id}`, contactName: null, lastPreview: null });
    for (const m of store.waMessage) expect(m).toMatchObject({ body: null, mediaFilename: null, mediaId: null, wamid: null });
    expect(store.waMediaBlob).toHaveLength(0);
    // lista manual pelo número (sem clientId)
    expect(store.campaignRecipient[0]).toMatchObject({ nome: "Contato anonimizado", telefone: "anon-r1", limiteDisponivel: null });
    // mensagens de campanha: resultado fica, id na operadora e erro (com o número) saem
    expect(store.messageEvent[0]).toMatchObject({ status: "ENTREGUE", providerMsgId: null, error: null });
    // compras: SQL cru pelo tenantRaw, escopado por tenant e cliente
    expect(mockTenantRaw.execute).toHaveBeenCalledWith(expect.stringContaining('UPDATE "Purchase" SET "externalId"'), "t1", "c1");
    // histórico por pessoa apagado; o de outro cliente fica
    expect(store.accountSnapshot).toHaveLength(0);
    expect(store.movement).toHaveLength(0);
    expect(store.importChange.map((i) => i.id)).toEqual(["ic2", "ic3"]);
    expect(store.notification).toHaveLength(0);
    expect(r!.anonimizados).toMatchObject({ compras: 3, conversas: 2, destinatarios: 1 });
    // o outro cliente não foi tocado
    expect(store.client.find((x) => x.id === "c2")!.nome).toBe("Maria Souza");
  });

  it("LGPD 04-08: avisa que a Z-API guarda cópia no aparelho, no resultado e na auditoria", async () => {
    const r = await emTenant(() => anonymizeClient(prisma as any, "t1", "c1", { motivo: "x", origem: "PEDIDO_TITULAR", agora: AGORA }));
    expect(r!.copiasExternas).toEqual([expect.objectContaining({ provedor: "ZAPI", conversas: 1 })]);
    const evento = store.auditLog.find((a) => a.action === "ELIMINACAO_TITULAR")!;
    expect(evento.details.copiasExternas).toEqual([{ provedor: "ZAPI", conversas: 1, apagarManualmente: true }]);
  });

  it("cliente de outro tenant: null e nada muda", async () => {
    const r = await runWithTenantContextAsync("t2", () => anonymizeClient(prisma as any, "t2", "c1", { motivo: "x", origem: "PEDIDO_TITULAR" }));
    expect(r).toBeNull();
    expect(store.client[0].nome).toBe("João Silva");
  });
});

describe("anonymizeContato (LGPD 03-09): quem não é cliente da base", () => {
  const FORA = "+5584977776666";
  function contatoForaDaBase() {
    store.conversation.push({ id: "conv3", tenantId: "t1", clientId: null, waId: "5584977776666", contactName: "Zé", lastPreview: "apaga meus dados", lastMessageAt: diasAntes(1), account: { provider: "META" } });
    store.waMessage.push({ id: "m3", tenantId: "t1", conversationId: "conv3", body: "apaga meus dados", mediaFilename: "doc.pdf", mediaId: "mid3", errorText: null, wamid: "w3", timestamp: diasAntes(1) });
    store.waMediaBlob.push({ id: "b3", tenantId: "t1", messageId: "m3", createdAt: diasAntes(1) });
    store.campaignRecipient.push(
      { id: "r5", tenantId: "t1", clientId: null, nome: "Zé da lista", telefone: FORA, cpfHash: null, cpfMasked: null, limiteDisponivel: 100, createdAt: diasAntes(3) },
      { id: "r6", tenantId: "t1", clientId: null, nome: "Outro dono", telefone: FORA, cpfHash: "hash-outro", cpfMasked: "x", limiteDisponivel: 50, createdAt: diasAntes(3) },
    );
    store.messageEvent.push({ id: "e5", clientId: null, recipientId: "r5", providerMsgId: "wamid.Z", error: "falhou para +5584977776666", status: "ENTREGUE" });
  }

  it("grava supressão só pelo número, limpa conversa, mídia, lista e ids de envio, e audita sem PII", async () => {
    contatoForaDaBase();
    const r: any = await emTenant(() => anonymizeContato(prisma as any, "t1", "(84) 97777-6666", { motivo: "pedido", pedidoId: "p9", agora: AGORA }));
    expect(r).toMatchObject({ supressaoGravada: true, removidos: { midias: 1 }, anonimizados: { conversas: 1, destinatarios: 1, mensagensCampanha: 1 } });
    const sup = store.supressaoTitular.at(-1)!;
    expect(sup).toMatchObject({ motivo: "ELIMINACAO", phoneHash: phoneHash(SALT, FORA), docHash: null, createdAt: new Date("2026-10-18T03:00:00Z") });
    expect(store.conversation.find((c) => c.id === "conv3")).toMatchObject({ waId: "anon-conv3", contactName: null, lastPreview: null });
    expect(store.waMessage.find((m) => m.id === "m3")).toMatchObject({ body: null, mediaFilename: null, wamid: null });
    expect(store.waMediaBlob.find((b) => b.id === "b3")).toBeUndefined();
    expect(store.campaignRecipient.find((x) => x.id === "r5")).toMatchObject({ nome: "Contato anonimizado", telefone: "anon-r5" });
    // mesmo número com OUTRO documento é outra pessoa (número reaproveitado)
    expect(store.campaignRecipient.find((x) => x.id === "r6")).toMatchObject({ nome: "Outro dono", telefone: FORA });
    expect(store.messageEvent.find((e) => e.id === "e5")).toMatchObject({ providerMsgId: null, error: null, status: "ENTREGUE" });
    // o resto da base não muda
    expect(store.conversation.find((c) => c.id === "conv1")!.waId).toBe("5584999998888");
    const evento = store.auditLog.find((a) => a.action === "ELIMINACAO_CONTATO")!;
    expect(evento.targetId).toBe("p9");
    expect(JSON.stringify(evento)).not.toMatch(/7777|Zé/);
  });

  it("número de cliente da base: não mexe em nada e devolve o id (a eliminação é a da ficha)", async () => {
    const r = await emTenant(() => anonymizeContato(prisma as any, "t1", "+5584999998888", { motivo: "x" }));
    expect(r).toEqual({ clienteDaBase: "c1" });
    expect(store.supressaoTitular ?? []).toHaveLength(0);
    expect(store.conversation.find((c) => c.id === "conv1")!.waId).toBe("5584999998888");
  });

  it("telefone inválido: null", async () => {
    expect(await emTenant(() => anonymizeContato(prisma as any, "t1", "123", { motivo: "x" }))).toBeNull();
  });
});

describe("cadeia de auditoria x anonimização (pendência do Lote 5)", () => {
  it("tira a PII de AuditLog antigos do cliente e verifyAuditChain do tenant continua íntegra", async () => {
    await emTenant(async () => {
      await logAudit({ tenantId: "t1", userId: "u1", action: "UPDATE_CLIENT", target: "Client", targetId: "c1", details: { nome: "João Silva", telefone: "+5584999998888", statusConta: "ATIVO" } });
      await logAudit({ tenantId: "t1", userId: "u1", action: "UPDATE_CLIENT", target: "Client", targetId: "c2", details: { nome: "Maria Souza" } });
      await logAudit({ tenantId: "t1", userId: "u1", action: "EXPORT_CLIENTS", target: "Client", details: { count: 2 } });
      await anonymizeClient(prisma as any, "t1", "c1", { motivo: "pedido", origem: "PEDIDO_TITULAR", agora: AGORA });
    });

    const doC1 = store.auditLog.find((a) => a.action === "UPDATE_CLIENT" && a.targetId === "c1")!;
    expect(doC1.details).toEqual({ nome: REDACTED_MARKER, telefone: REDACTED_MARKER, statusConta: "ATIVO" });
    expect(store.auditLog.find((a) => a.targetId === "c2")!.details).toEqual({ nome: "Maria Souza" }); // outro cliente: intacto
    expect(JSON.stringify(store.auditLog)).not.toMatch(/João|99998888/);

    const v = await verifyAuditChain("t1");
    expect(v).toMatchObject({ valid: true, redigidas: 1 });
  });

  it("prova: reescrever details sem o evento encadeado (como a retenção antiga fazia) quebra a verificação", async () => {
    await emTenant(() => logAudit({ tenantId: "t1", action: "UPDATE_CLIENT", target: "Client", targetId: "c1", details: { nome: "João Silva" } }));
    store.auditLog.find((a) => a.action === "UPDATE_CLIENT")!.details = { nome: REDACTED_MARKER };
    await expect(verifyAuditChain("t1")).resolves.toMatchObject({ valid: false, motivo: "CONTEUDO" });
  });
});

describe("runRetentionSweep (job diário)", () => {
  it("anonimiza o inativo, mas não quem usou pelo extrato ou escreveu no período (LGPD 03-01)", async () => {
    store.client.push(
      clienteCompleto({ id: "c3", telefone: "+5584933334444", cpfHash: "h3", ultimoUsoReal: diasAntes(5) }), // ativação antiga, mas usa o cartão
    );
    const r = await runRetentionSweep(prisma as any, AGORA);
    expect(store.client.find((x) => x.id === "c1")!.anonymizedAt).toEqual(AGORA);
    expect(store.client.find((x) => x.id === "c2")!.anonymizedAt).toBeNull();
    expect(store.client.find((x) => x.id === "c3")!.anonymizedAt).toBeNull();
    expect(r.totalAnonymized).toBe(1);
    const where = mockPrisma.client.findMany.mock.calls.find((c) => c[0].where?.anonymizedAt === null && c[0].where?.AND)![0].where;
    expect(JSON.stringify(where)).toContain("ultimoUsoReal");
    expect(where.AND[2]).toEqual({ conversations: { none: { lastInboundAt: { gt: diasAntes(1095) } } } });
  });

  it("conta encerrada: prazo próprio contado do encerramento (LGPD 04-06)", async () => {
    store.tenant[0].retentionDaysAfterClosure = 30;
    store.client.find((x) => x.id === "c2")!.encerradoEm = diasAntes(31);
    const r = await runRetentionSweep(prisma as any, AGORA);
    expect(store.client.find((x) => x.id === "c2")!.anonymizedAt).toEqual(AGORA);
    expect(r.anonimizadosEncerramento).toBe(1);
  });

  it("limpa o que sobrou de clientes anonimizados pela versão antiga (e-mail, id do cartão, RH)", async () => {
    store.client.push(clienteCompleto({ id: "c9", nome: ANON_NOME, telefone: "anon-c9", cpfHash: "anon-c9", anonymizedAt: diasAntes(100), dataUltimaUtilizacao: diasAntes(3) }));
    const r = await runRetentionSweep(prisma as any, AGORA);
    const c9 = store.client.find((x) => x.id === "c9")!;
    expect(c9).toMatchObject({ email: null, externalId: null, lotacao: null, remuneracaoBruta: null, anonymizedAt: diasAntes(100) });
    expect(r.residuosLimpos).toBe(1);
    // não grava supressão (os hashes reais já tinham sido perdidos)
    expect(store.supressaoTitular.filter((s) => s.docHash === "anon-c9")).toHaveLength(0);
  });

  it("Inbox (LGPD 04-02): conteúdo antigo e conversa parada saem, também sem cliente; mídia tem prazo próprio", async () => {
    store.tenant[0].inboxRetentionDays = 5;
    store.tenant[0].mediaRetentionDays = 3;
    store.client = []; // só a Inbox
    store.conversation.push({ id: "conv3", tenantId: "t1", clientId: null, waId: "5584977776666", contactName: "Z", lastPreview: "atual", lastMessageAt: diasAntes(1), account: { provider: "META" } });
    store.waMessage.push({ id: "m3", tenantId: "t1", conversationId: "conv3", body: "recente", mediaFilename: null, mediaId: null, errorText: null, timestamp: diasAntes(1) });
    store.waMediaBlob.push({ id: "b3", tenantId: "t1", messageId: "m3", createdAt: diasAntes(4) }, { id: "b4", tenantId: "t1", messageId: "m3", createdAt: diasAntes(1) });

    const r = await runRetentionSweep(prisma as any, AGORA);
    expect(store.waMessage.find((m) => m.id === "m1")!.body).toBeNull();
    expect(store.waMessage.find((m) => m.id === "m3")!.body).toBe("recente");
    expect(store.conversation.find((c) => c.id === "conv2")).toMatchObject({ waId: "anon-conv2", contactName: null });
    expect(store.conversation.find((c) => c.id === "conv3")!.waId).toBe("5584977776666");
    expect(store.waMediaBlob.map((b) => b.id)).toEqual(["b4"]);
    expect(r.inbox).toMatchObject({ mensagens: 2, conversas: 2 });
  });

  it("estado de desfazer importação expira em 30 dias para todos os formatos (LGPD 04-04)", async () => {
    store.client = [];
    const r = await runRetentionSweep(prisma as any, AGORA);
    expect(store.importChange.map((i) => i.id).sort()).toEqual(["ic1", "ic3"]);
    expect(r.importChangesExpirados).toBe(1);
  });
});

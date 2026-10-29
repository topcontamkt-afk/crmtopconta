import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { configureDatabase, prisma } from "../config/db";
import { d1LikeAdapter } from "../config/d1Like";
import { migrationStatements } from "../config/d1Migrations";
import { runWithTenantContextAsync, withCrossTenantAccess } from "../config/tenantGuard";
import { MockWhatsAppAdapter } from "../services/channels/whatsapp";

/**
 * Disparo em lote sobre SQLite com os limites do D1. Incidente de 22/10/2026: 12 chamadas de /dispatch ao mesmo
 * tempo enviaram as mesmas mensagens várias vezes. Aqui: cada mensagem sai exatamente UMA vez mesmo com disparos
 * simultâneos, erro de infraestrutura não vira FALHA, o orçamento de tempo devolve o resto à fila e a homologação só
 * envia para números de teste.
 */

process.env.JWT_SECRET ||= randomBytes(32).toString("hex");
process.env.CREDENTIALS_ENCRYPTION_KEY ||= randomBytes(32).toString("base64");
process.env.MESSAGING_MODE = "mock";

const N = 195;
const dbFile = join(tmpdir(), `crm-disparo-${randomUUID()}.sqlite`);
let app: Express;
let token = "";
let tenantId = "";
const telefone = (i: number) => `+5579988${String(100000 + i)}`;
const clientes: string[] = [];
const enviados: string[] = [];
let envio = jest.spyOn(MockWhatsAppAdapter.prototype, "send");

const dispatch = (id: string, limit = 25) => request(app).post(`/api/campaigns/${id}/dispatch`).set("authorization", `Bearer ${token}`).send({ limit });

/** Cria uma campanha com os `n` primeiros clientes na fila. */
/** `texto` igual em duas campanhas = a mesma mensagem (a trava de repetição vale por mensagem). Por padrão cada teste tem a sua. */
async function novaCampanha(n: number, nome = "limite", texto = `Olá {{nome}}, seu limite {{limite_disponivel}}. [${nome}]`) {
  return runWithTenantContextAsync(tenantId, async () => {
    const campaign = await prisma.campaign.create({
      data: { tenantId, name: nome, channel: "WHATSAPP", messageTemplate: texto, status: "AGENDADA", audienceCount: n, baseLegal: "CONSENTIMENTO" },
    });
    for (let i = 0; i < n; i++) await prisma.messageEvent.create({ data: { tenantId, campaignId: campaign.id, clientId: clientes[i], channel: "WHATSAPP", status: "FILA" } });
    return campaign.id;
  });
}

const contagem = (campaignId: string) =>
  runWithTenantContextAsync(tenantId, async () => {
    const grupos = await prisma.messageEvent.groupBy({ by: ["status"], where: { campaignId }, _count: { _all: true } });
    return Object.fromEntries(grupos.map((g) => [g.status, g._count._all])) as Record<string, number>;
  });

beforeAll(async () => {
  configureDatabase(() => d1LikeAdapter(`file:${dbFile}`));
  app = (await import("../app")).default as Express;
  const { signToken } = await import("../middleware/auth");
  await withCrossTenantAccess(async () => {
    for (const stmt of migrationStatements()) await prisma.$executeRawUnsafe(stmt);
    tenantId = (await prisma.tenant.create({ data: { name: "Disparo", baseLegalMarketing: "CONSENTIMENTO" } })).id;
  });
  await runWithTenantContextAsync(tenantId, async () => {
    const admin = await prisma.user.create({ data: { tenantId, name: "Admin", email: "admin@disparo.test", passwordHash: "x", role: "ADMIN" } });
    token = signToken({ id: admin.id, tenantId, role: "ADMIN", email: admin.email });
    for (let i = 0; i < N; i++) {
      const c = await prisma.client.create({
        data: { tenantId, nome: `Cliente ${i}`, telefone: telefone(i), cpfHash: `h${i}`, cpfMasked: "***", cidade: "Luziânia", limiteTotal: 1000, saldoDisponivel: 500, valorUtilizado: 500, statusConta: "ATIVO", autorizacaoComunicacao: true },
      });
      clientes.push(c.id);
    }
  });
});

/** O limite global da empresa (maxMsgsPerMinute) conta os envios do último minuto; cada teste começa com a janela limpa. */
const limparJanelaDeTaxa = () =>
  runWithTenantContextAsync(tenantId, () => prisma.messageEvent.updateMany({ where: { sentAt: { gte: new Date(Date.now() - 90_000) } }, data: { sentAt: new Date(Date.now() - 10 * 60_000) } }));

beforeEach(async () => {
  await limparJanelaDeTaxa();
  enviados.length = 0;
  envio.mockRestore();
  envio = jest.spyOn(MockWhatsAppAdapter.prototype, "send").mockImplementation(async (to: string) => {
    enviados.push(to);
    return { providerMessageId: `mock-${enviados.length}`, status: "SENT", cost: 0.05 };
  });
  delete process.env.APP_ENV;
  delete process.env.ENVIO_PERMITIDO_PARA;
  delete process.env.DISPATCH_ORCAMENTO_MS;
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(dbFile, { force: true });
});

it("dispara os 195 em lotes de 25 sem erro", async () => {
  const id = await novaCampanha(N);
  let restante = N;
  for (let volta = 0; volta < 12 && restante > 0; volta++) {
    const r = await dispatch(id);
    if (r.status !== 200) throw new Error(`volta ${volta}: ${r.status} ${JSON.stringify(r.body)}`);
    restante = r.body.remaining;
  }
  expect(restante).toBe(0);
  expect(enviados).toHaveLength(N);
});

it("disparos SIMULTÂNEOS: cada mensagem sai exatamente uma vez", async () => {
  const id = await novaCampanha(N, "simultaneo");
  let restante = N;
  for (let rodada = 0; rodada < 40 && restante > 0; rodada++) {
    const respostas = await Promise.all(Array.from({ length: 6 }, () => dispatch(id)));
    for (const r of respostas) expect([200, 409]).toContain(r.status);
    restante = Math.min(...respostas.filter((r) => r.status === 200).map((r) => r.body.remaining), restante);
    if (respostas.every((r) => r.status === 409)) continue;
  }
  const c = await contagem(id);
  expect(c.FILA ?? 0).toBe(0);
  expect(c.ENVIADO).toBe(N);
  expect(enviados).toHaveLength(N); // nenhuma cópia
  expect(new Set(enviados).size).toBe(N); // e ninguém ficou sem
});

it("segunda chamada com um disparo em andamento responde 409 e não envia nada", async () => {
  const id = await novaCampanha(5, "trava");
  const travar = (ate: Date) => runWithTenantContextAsync(tenantId, () => prisma.tenant.update({ where: { id: tenantId }, data: { dispatchToken: "outro", dispatchUntil: ate, dispatchCampaignId: "qualquer" } }));
  await travar(new Date(Date.now() + 60_000));
  const r = await dispatch(id);
  expect(r.status).toBe(409);
  expect(r.body.code).toBe("DISPARO_EM_ANDAMENTO");
  expect(enviados).toHaveLength(0);
  // trava vencida não prende a campanha para sempre
  await runWithTenantContextAsync(tenantId, () => prisma.tenant.update({ where: { id: tenantId }, data: { dispatchUntil: new Date(Date.now() - 1000) } }));
  expect((await dispatch(id)).status).toBe(200);
  expect(enviados).toHaveLength(5);
});

it("erro de infraestrutura (limite do Worker) NÃO vira FALHA: o item volta à fila e o disparo para", async () => {
  const id = await novaCampanha(10, "infra");
  let chamadas = 0;
  envio.mockImplementation(async (to: string) => {
    chamadas++;
    if (chamadas === 4) return { providerMessageId: "", status: "FAILED", error: "Não foi possível falar com a Meta: Too many subrequests by single Worker invocation." } as any;
    enviados.push(to);
    return { providerMessageId: `m${chamadas}`, status: "SENT", cost: 0.05 };
  });
  const r = await dispatch(id);
  expect(r.status).toBe(200);
  expect(r.body.parcial).toBe("limite da plataforma");
  const c = await contagem(id);
  expect(c.ENVIADO).toBe(3);
  expect(c.FALHA ?? 0).toBe(0);
  expect(c.FILA).toBe(7);
  // a próxima chamada continua de onde parou, sem repetir os 3 já enviados
  envio.mockImplementation(async (to: string) => {
    enviados.push(to);
    return { providerMessageId: "x", status: "SENT", cost: 0.05 };
  });
  await dispatch(id);
  expect(enviados).toHaveLength(10);
  expect(new Set(enviados).size).toBe(10);
});

it("orçamento de tempo estourado devolve o que sobrou à fila", async () => {
  const id = await novaCampanha(10, "tempo");
  process.env.DISPATCH_ORCAMENTO_MS = "1";
  envio.mockImplementation(async (to: string) => {
    enviados.push(to);
    await new Promise((r) => setTimeout(r, 15));
    return { providerMessageId: "x", status: "SENT", cost: 0.05 };
  });
  const r = await dispatch(id);
  expect(r.body.parcial).toBe("tempo");
  const c = await contagem(id);
  expect(c.ENVIADO).toBeGreaterThanOrEqual(1);
  expect(c.ENVIADO).toBeLessThan(10);
  expect((c.ENVIADO ?? 0) + (c.FILA ?? 0)).toBe(10); // nada perdido, nada em limbo
});

it("telefone repetido na mesma campanha não recebe duas vezes", async () => {
  const id = await runWithTenantContextAsync(tenantId, async () => {
    const campaign = await prisma.campaign.create({ data: { tenantId, name: "repetido", channel: "WHATSAPP", messageTemplate: "Olá {{nome}}", status: "AGENDADA", audienceCount: 2, baseLegal: "CONSENTIMENTO" } });
    const a = await prisma.client.create({ data: { tenantId, nome: "Dup A", telefone: "+5579911112222", cpfHash: "dupA", cpfMasked: "***", limiteTotal: 1000, statusConta: "ATIVO", autorizacaoComunicacao: true } });
    const b = await prisma.client.create({ data: { tenantId, nome: "Dup B", telefone: "+5579911112222", cpfHash: "dupB", cpfMasked: "***", limiteTotal: 1000, statusConta: "ATIVO", autorizacaoComunicacao: true } });
    for (const c of [a, b]) await prisma.messageEvent.create({ data: { tenantId, campaignId: campaign.id, clientId: c.id, channel: "WHATSAPP", status: "FILA" } });
    return campaign.id;
  });
  await dispatch(id);
  expect(enviados).toEqual(["+5579911112222"]);
  const c = await contagem(id);
  expect(c).toMatchObject({ ENVIADO: 1, BLOQUEADO: 1 });
});

it("homologação só envia para os números de teste", async () => {
  process.env.APP_ENV = "hml";
  process.env.ENVIO_PERMITIDO_PARA = `${telefone(1)}, ${telefone(3)}`;
  const id = await novaCampanha(6, "hml");
  await dispatch(id);
  expect(enviados.sort()).toEqual([telefone(1), telefone(3)].sort());
  expect((await contagem(id)).BLOQUEADO).toBe(4);
});

it("homologação com a lista vazia não envia nada de verdade", async () => {
  process.env.APP_ENV = "hml";
  const id = await novaCampanha(4, "hml-vazia");
  await dispatch(id);
  expect(enviados).toHaveLength(0);
  expect((await contagem(id)).BLOQUEADO).toBe(4);
});

it("campanha pausada não envia; retomada volta a enviar", async () => {
  const id = await novaCampanha(3, "pausa");
  expect((await request(app).post(`/api/campaigns/${id}/pause`).set("authorization", `Bearer ${token}`)).status).toBe(200);
  const r = await dispatch(id);
  expect(r.body.bloqueado).toMatch(/pausada/i);
  expect(enviados).toHaveLength(0);
  expect((await request(app).post(`/api/campaigns/${id}/resume`).set("authorization", `Bearer ${token}`)).status).toBe(200);
  await dispatch(id);
  expect(enviados).toHaveLength(3);
});

it("a lista de campanhas traz a contagem por status e se há disparo em andamento", async () => {
  const id = await novaCampanha(4, "lista");
  await dispatch(id);
  const r = await request(app).get("/api/campaigns").set("authorization", `Bearer ${token}`);
  const c = r.body.find((x: any) => x.id === id);
  expect(c.contagem).toMatchObject({ enviadas: 4, fila: 0, falhas: 0 });
  expect(c.emDisparo).toBe(false);
  expect(c.dispatchToken).toBeUndefined();
});

/** Drena uma ou mais campanhas com vários disparadores ao mesmo tempo; devolve quando todas esvaziam. */
async function drenarEmParalelo(ids: string[], paralelos: number, rodadas = 60) {
  for (let rodada = 0; rodada < rodadas; rodada++) {
    // a ordem gira a cada rodada: quem chega primeiro leva a trava, e nenhuma campanha fica sempre atrás
    const alvos = Array.from({ length: paralelos }, (_, i) => ids[(i + rodada) % ids.length]);
    await Promise.all(alvos.map((id) => dispatch(id)));
    const filas = await Promise.all(ids.map(async (id) => (await contagem(id)).FILA ?? 0));
    if (filas.every((f) => f === 0)) return;
  }
}

it("DUAS campanhas iguais (lançamento clicado duas vezes) disparadas ao mesmo tempo: cada pessoa recebe uma vez", async () => {
  const a = await novaCampanha(60, "dupla", "Oferta dupla {{nome}}");
  const b = await novaCampanha(60, "dupla", "Oferta dupla {{nome}}"); // mesmo público, mesma mensagem
  await drenarEmParalelo([a, b], 8);
  expect(enviados).toHaveLength(60);
  expect(new Set(enviados).size).toBe(60);
  const ca = await contagem(a);
  const cb = await contagem(b);
  expect((ca.ENVIADO ?? 0) + (cb.ENVIADO ?? 0)).toBe(60);
  expect((ca.BLOQUEADO ?? 0) + (cb.BLOQUEADO ?? 0)).toBe(60); // a metade repetida ficou bloqueada, não enviada
});

it("o disparo seguinte de uma campanha idêntica, depois de enviada, não reenvia a ninguém", async () => {
  const a = await novaCampanha(20, "sequencial", "Oferta sequencial {{nome}}");
  await drenarEmParalelo([a], 1);
  expect(enviados).toHaveLength(20);
  const b = await novaCampanha(20, "sequencial", "Oferta sequencial {{nome}}");
  await drenarEmParalelo([b], 1);
  expect(enviados).toHaveLength(20);
  expect((await contagem(b)).BLOQUEADO).toBe(20);
});

it("CAOS: falhas aleatórias (limite do Worker, recusa da Meta, exceção) com 8 disparadores: ninguém recebe duas vezes", async () => {
  const id = await novaCampanha(120, "caos");
  let semente = Number(process.env.CAOS_SEMENTE) || 12345;
  const aleatorio = () => ((semente = (semente * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  envio.mockImplementation(async (to: string) => {
    const x = aleatorio();
    if (x < 0.08) return { providerMessageId: "", status: "FAILED", error: "Too many subrequests by single Worker invocation" } as any; // volta à fila
    if (x < 0.12) throw new Error("conexão caiu"); // exceção no meio do lote: a reserva fica parada
    if (x < 0.2) return { providerMessageId: "", status: "FAILED", error: "131049 not delivered" } as any; // recusa definitiva
    await new Promise((r) => setTimeout(r, aleatorio() * 4));
    enviados.push(to);
    return { providerMessageId: `m${enviados.length}`, status: "SENT", cost: 0.05 };
  });
  process.env.DISPATCH_ORCAMENTO_MS = "30";
  await drenarEmParalelo([id], 8, 80);
  // reservas deixadas por exceções só voltam a valer depois de 30 min: avança o relógio das reservas e continua
  await runWithTenantContextAsync(tenantId, () => prisma.messageEvent.updateMany({ where: { campaignId: id, status: "FILA" }, data: { claimedAt: new Date(Date.now() - 31 * 60_000) } }));
  await drenarEmParalelo([id], 8, 80);
  await runWithTenantContextAsync(tenantId, () => prisma.messageEvent.updateMany({ where: { campaignId: id, status: "FILA" }, data: { claimedAt: new Date(Date.now() - 31 * 60_000) } }));
  await drenarEmParalelo([id], 8, 80);
  expect(new Set(enviados).size).toBe(enviados.length); // NINGUÉM recebeu duas vezes
  const c = await contagem(id);
  expect((c.ENVIADO ?? 0)).toBe(enviados.length); // o que foi enviado está registrado como enviado
  expect((c.ENVIADO ?? 0) + (c.FALHA ?? 0) + (c.FILA ?? 0)).toBe(120); // nada perdido
}, 120_000);

it("o funil ao vivo e o relatório trazem pessoas, visualizaram, clicaram e as taxas", async () => {
  const id = await novaCampanha(10, "funil");
  await dispatch(id);
  // simula os recibos da Meta e cliques: 3 só enviadas→entregues, 4 lidas (1 respondeu), 2 clicaram (1 sem recibo de leitura)
  const eventos = await runWithTenantContextAsync(tenantId, () => prisma.messageEvent.findMany({ where: { campaignId: id }, orderBy: { id: "asc" } }));
  const mudar = (i: number, data: object) => runWithTenantContextAsync(tenantId, () => prisma.messageEvent.update({ where: { id: eventos[i].id }, data }));
  for (const i of [0, 1, 2]) await mudar(i, { status: "ENTREGUE" });
  for (const i of [3, 4, 5]) await mudar(i, { status: "LIDO" });
  await mudar(6, { status: "RESPONDIDO" });
  await mudar(4, { clickedAt: new Date(), clickCount: 2 }); // lida e clicou
  await mudar(7, { clickedAt: new Date(), clickCount: 1 }); // ficou só ENVIADO, mas clicou: conta como entregue e visualizou

  const r = await request(app).get(`/api/campaigns/${id}/funil`).set("authorization", `Bearer ${token}`);
  expect(r.status).toBe(200);
  expect(r.body.funil).toMatchObject({ publico: 10, naFila: 0, enviadas: 10, entregues: 8, visualizaram: 5, clicaram: 2 });
  expect(r.body.funil.etapas.map((e: any) => e.chave)).toEqual(["publico", "enviadas", "entregues", "visualizaram", "clicaram"]);
  expect(r.body.emDisparo).toBe(false);
  expect(r.body.ultimos.length).toBeGreaterThan(0);
  expect(r.body.ultimos[0].telefone).toMatch(/\*/); // telefone sempre mascarado
  expect(JSON.stringify(r.body)).not.toContain(telefone(0)); // nenhum telefone completo

  const rel = await request(app).get(`/api/campaigns/${id}/report`).set("authorization", `Bearer ${token}`);
  expect(rel.status).toBe(200);
  expect(rel.body.funil).toMatchObject({ publico: 10, enviadas: 10, entregues: 8, visualizaram: 5, clicaram: 2 });
  expect(rel.body.funil.usaram).toBe(rel.body.conversoes);
  expect((await request(app).get("/api/campaigns/inexistente/funil").set("authorization", `Bearer ${token}`)).status).toBe(404);
});

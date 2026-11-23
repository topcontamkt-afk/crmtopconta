import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { d1LikeAdapter } from "../config/d1Like";
import { configureDatabase, prisma } from "../config/db";
import { migrationStatements } from "../config/d1Migrations";
import { runWithTenantContextAsync, withCrossTenantAccess } from "../config/tenantGuard";
import { periodoDoMes } from "../services/financeiro";

/**
 * Insights (fases 1–5) no dialeto do SQLite/D1: cidades, horários, convênios, fontes, financeiro, metas, risco e a
 * tendência da fila, rodando pela API inteira contra um SQLite de verdade com as mesmas migrations do D1. Os números
 * esperados saem dos dados montados aqui (janelas de 30 dias móveis, então não dependem do dia do mês).
 */

process.env.JWT_SECRET ||= randomBytes(32).toString("hex");
process.env.CREDENTIALS_ENCRYPTION_KEY ||= randomBytes(32).toString("base64");

const dbFile = join(tmpdir(), `crm-negocio-${randomUUID()}.sqlite`);
let app: Express;
let admin = "";
let viewer = "";
let tenantId = "";
let outroTenantId = "";
const ids: Record<string, string> = {};

const DIA = 24 * 3600_000;
const agora = Date.now();
const get = (url: string, token = admin) => request(app).get(url).set("authorization", `Bearer ${token}`);
const hojeBrt = new Date(agora - 3 * 3600_000).toISOString().slice(0, 10);

/** Instante `dias` atrás, às `horaUtc` UTC (12h BRT = 15h UTC). */
const quando = (dias: number, horaUtc: number) => {
  const d = new Date(agora - dias * DIA);
  d.setUTCHours(horaUtc, 0, 0, 0);
  return d;
};
const diaBrtDe = (d: Date) => new Date(d.getTime() - 3 * 3600_000).toISOString().slice(0, 10);

interface Compra { dias: number; hora: number; juros: number | null; tipo: string; valor: number; clientId: string }
const compras: Compra[] = [];

beforeAll(async () => {
  configureDatabase(() => d1LikeAdapter(`file:${dbFile}`));
  app = (await import("../app")).default as Express;
  const { signToken } = await import("../middleware/auth");

  await withCrossTenantAccess(async () => {
    for (const stmt of migrationStatements()) await prisma.$executeRawUnsafe(stmt);
    tenantId = (await prisma.tenant.create({ data: { name: "Negócio" } })).id;
    outroTenantId = (await prisma.tenant.create({ data: { name: "Outro" } })).id;
  });

  await runWithTenantContextAsync(tenantId, async () => {
    const u = await prisma.user.create({ data: { tenantId, name: "Admin", email: "admin@negocio.test", passwordHash: "x", role: "ADMIN" } });
    const v = await prisma.user.create({ data: { tenantId, name: "Viewer", email: "viewer@negocio.test", passwordHash: "x", role: "VIEWER" } });
    admin = signToken({ id: u.id, tenantId, role: "ADMIN", email: u.email });
    viewer = signToken({ id: v.id, tenantId, role: "VIEWER", email: v.email });

    let n = 0;
    const cliente = (nome: string, cidade: string, convenio: string | null, limite: number, extra: Record<string, unknown> = {}) =>
      prisma.client.create({
        data: {
          tenantId, nome, cidade, empresaConveniada: convenio, limiteTotal: limite, valorUtilizado: 0, saldoDisponivel: limite, percentualUtilizado: 0,
          faixaUso: "SEM_USO", statusConta: "ATIVO", autorizacaoComunicacao: true, telefone: `+5584900${String(1000 + n).slice(-4)}${String(n++).padStart(2, "0")}`,
          cpfHash: randomUUID(), cpfMasked: "***", ...extra,
        },
      });

    // Natal: 40 clientes (limite 1.200 = PF1). Lagarto: 35 (limite 2.000 = PF2) + 100 que usaram uma vez há 70 dias (risco alto).
    const natal: string[] = [];
    for (let i = 0; i < 40; i++) natal.push((await cliente(`Natal ${i}`, "Natal", "Prefeitura de Natal", 1200)).id);
    const lagarto: string[] = [];
    for (let i = 0; i < 35; i++) lagarto.push((await cliente(`Lagarto ${i}`, "Lagarto", "Secretaria de Educacao", 2000)).id);
    const inativos: string[] = [];
    for (let i = 0; i < 100; i++) inativos.push((await cliente(`Parado ${i}`, "Lagarto", "Secretaria de Educacao", 2000)).id);
    ids.semConvenio = (await cliente("Sem Convenio", "Natal", null, 1200)).id;
    ids.anon = (await cliente("Anonimizado", "Natal", "Prefeitura de Natal", 1200, { anonymizedAt: new Date() })).id;
    ids.outro = ids.anon;

    const compra = (clientId: string, dias: number, hora: number, juros: number | null, tipo = "Débito Pix Cartão", valor = 100) => {
      compras.push({ dias, hora, juros, tipo, valor, clientId });
      return prisma.purchase.create({ data: { tenantId, clientId, tipo, valorPrincipal: valor, juros, occurredAt: quando(dias, hora), externalId: randomUUID() } });
    };
    // Natal sobe: 30 usaram na janela atual (dias 1–10, 12h BRT) e 15 na anterior (dias 35–45)
    for (let i = 0; i < 30; i++) await compra(natal[i], 1 + (i % 10), 15, 10);
    for (let i = 0; i < 15; i++) await compra(natal[i], 35 + (i % 10), 15, 10);
    // Lagarto cai: 10 na atual e 30 na anterior (19h BRT = 22h UTC)
    for (let i = 0; i < 10; i++) await compra(lagarto[i], 2 + (i % 8), 22, 20, "Débito Pix Cartão", 200);
    for (let i = 0; i < 30; i++) await compra(lagarto[i], 36 + (i % 8), 22, 20, "Débito Pix Cartão", 200);
    // compra à vista (sem juros) de Natal, para o lucro ignorá-la
    for (let i = 30; i < 35; i++) await compra(natal[i], 3, 15, null, "Compra à Vista Cartão Top Convênio", 50);
    // parados: uma antecipação há 70 dias, e o saldo continua todo disponível
    for (const id of inativos) await compra(id, 70, 13, 8); // 10h BRT
    // o anonimizado tem compra recente: não pode aparecer em nada
    await compra(ids.anon, 1, 15, 50);

    // 40 envios reais para clientes de Natal, 40 minutos antes do 1º uso deles (atraso medido = 40 min)
    const campanha = await prisma.campaign.create({ data: { tenantId, name: "Medição", channel: "WHATSAPP", messageTemplate: "Oi", status: "CONCLUIDA", audienceCount: 30, baseLegal: "CONSENTIMENTO" } });
    for (let i = 0; i < 30; i++) {
      const c = compras.find((x) => x.clientId === natal[i] && x.dias <= 10)!;
      await prisma.messageEvent.create({ data: { tenantId, campaignId: campanha.id, clientId: natal[i], channel: "WHATSAPP", status: "ENVIADO", sentAt: new Date(quando(c.dias, c.hora).getTime() - 40 * 60_000) } });
    }
    await prisma.cicloCidade.create({ data: { tenantId, cidadeKey: "lagarto", cidade: "Lagarto", diaAbertura: new Date(agora - 3 * 3600_000 + 3 * DIA).getUTCDate() } });
    const { refreshUsageColumns } = await import("../services/usageRefresh");
    const { refreshCicloColumns } = await import("../services/cicloRefresh");
    await refreshUsageColumns(tenantId);
    await refreshCicloColumns(tenantId);
  });
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(dbFile, { force: true });
});

describe("cidades-desempenho", () => {
  it("Natal sobe (destaque) e Lagarto cai (atenção); anonimizado e 'sem cidade' ficam fora", async () => {
    const r = await get("/api/dashboard/cidades-desempenho");
    expect(r.status).toBe(200);
    const natal = r.body.cidades.find((c: any) => c.cidadeKey === "natal");
    const lagarto = r.body.cidades.find((c: any) => c.cidadeKey === "lagarto");
    // 41 clientes com limite em Natal: os 40 + "Sem Convenio" (o anonimizado não conta)
    // 30 com antecipação + 5 só com compra à vista (também é uso) = 35; 15 na janela anterior
    expect(natal).toMatchObject({ clientes: 41, usaramAtual: 35, usaramAnterior: 15 });
    expect(lagarto).toMatchObject({ clientes: 135, usaramAtual: 10, usaramAnterior: 30 });
    expect(natal.situacao).toBe("destaque");
    expect(lagarto.situacao).toBe("atencao");
    expect(r.body.emDestaque.cidadeKey).toBe("natal");
    expect(r.body.precisaAtencao.cidadeKey).toBe("lagarto");
    expect(typeof lagarto.abreEmDias).toBe("number");
  });
});

describe("horarios", () => {
  it("pico por hora de Brasília, segmento por perfil e antecedência medida", async () => {
    const r = await get("/api/dashboard/horarios?tipo=antecipacao&por=perfil&dias=90");
    expect(r.status).toBe(200);
    const antecipacoes = compras.filter((c) => c.tipo.startsWith("Débito") && c.clientId !== ids.anon);
    expect(r.body.total.usos).toBe(antecipacoes.length);
    const pf1 = r.body.segmentos.find((s: any) => s.key === "PF1");
    const pf2 = r.body.segmentos.find((s: any) => s.key === "PF2");
    expect(pf1).toMatchObject({ clientes: 41, picoHora: 12 }); // Natal, 15h UTC = 12h BRT
    expect(pf2.picoHora).toBe(10); // os 100 parados, 13h UTC = 10h BRT
    expect(r.body.antecedencia).toMatchObject({ fonte: "medida", medianaMin: 40, amostra: 30 });
    expect(pf1.sugestao).toMatchObject({ horario: "11:20", picoHora: 12, antecedenciaMin: 40, ajustadoPelaJanela: false });
    expect(r.body.envios.total).toBe(30);
    expect(r.body.envios.porHora.reduce((a: number, b: number) => a + b, 0)).toBe(30);
  });

  it("por cidade e por tipo (compra à vista) e parâmetros inválidos", async () => {
    const c = await get("/api/dashboard/horarios?tipo=todos&por=cidade");
    expect(c.status).toBe(200);
    expect(c.body.segmentos.map((s: any) => s.key).sort()).toEqual(["lagarto", "natal"]);
    const compra = await get("/api/dashboard/horarios?tipo=compra&por=nenhum");
    expect(compra.body.total.usos).toBe(5);
    expect((await get("/api/dashboard/horarios?tipo=xx")).status).toBe(400);
  });
});

describe("convenios e fontes", () => {
  it("ranking de convênios com lucro das antecipações; anonimizado fora; sem convênio contado", async () => {
    const r = await get("/api/negocio/convenios");
    expect(r.status).toBe(200);
    const natal = r.body.convenios.find((c: any) => c.convenio === "Prefeitura de Natal");
    const edu = r.body.convenios.find((c: any) => c.convenio === "Secretaria de Educacao");
    // o lucro só soma juros de antecipação: as 5 compras à vista contam como uso, não como lucro
    expect(natal).toMatchObject({ clientes: 40, usaramAtual: 35, lucroAtual: 300, lucroAnterior: 150, lucroVariacaoPct: 100 });
    expect(edu).toMatchObject({ clientes: 135, usaramAtual: 10, lucroAtual: 200, lucroAnterior: 600 });
    expect(edu.situacao).toBe("atencao");
    expect(r.body.semConvenio.n).toBe(1);
  });

  it("frescor das fontes: extrato em dia, sem importação nem foto, disparo só informativo", async () => {
    const r = await get("/api/negocio/fontes");
    expect(r.status).toBe(200);
    const por = Object.fromEntries(r.body.fontes.map((f: any) => [f.key, f]));
    expect(por.extrato.status).toBe("ok");
    expect(por.extrato.dias).toBeLessThanOrEqual(1); // depende da hora em que o teste roda
    expect(por.contas.status).toBe("sem_dados");
    expect(por.contas.acao.destino).toBe("/imports");
    expect(por.disparo.status).toBe("info");
    expect(por.disparo.ultima).not.toBeNull();
    expect(por.webhook).toMatchObject({ status: "info", ultima: null });
  });
});

describe("financeiro e metas", () => {
  it("lucro do mês do último extrato contra o mês anterior até o mesmo dia", async () => {
    const r = await get("/api/negocio/financeiro");
    expect(r.status).toBe(200);
    const ultimo = compras.filter((c) => c.clientId !== ids.anon).map((c) => diaBrtDe(quando(c.dias, c.hora))).sort().pop()!;
    const p = periodoDoMes(ultimo)!;
    const noPeriodo = (de: string, ate: string) =>
      compras.filter((c) => c.clientId !== ids.anon && diaBrtDe(quando(c.dias, c.hora)) >= de && diaBrtDe(quando(c.dias, c.hora)) <= ate);
    const lucro = (xs: Compra[]) => xs.filter((c) => c.tipo.startsWith("Débito")).reduce((a, c) => a + (c.juros ?? 0), 0);
    expect(r.body.periodo.mes).toBe(p.mes);
    expect(r.body.atual.lucro).toBe(lucro(noPeriodo(p.atual.de, p.atual.ate)));
    expect(r.body.anterior.lucro).toBe(lucro(noPeriodo(p.anterior.de, p.anterior.ate)));
    expect(r.body.atual.usos).toBe(noPeriodo(p.atual.de, p.atual.ate).length);
    const semanas = r.body.semanas.reduce((a: number, s: any) => a + s.atual, 0);
    expect(semanas).toBe(r.body.atual.lucro);
    expect(r.body.porCidade.reduce((a: number, c: any) => a + c.lucro, 0)).toBe(r.body.atual.lucro);
    expect(r.body.porPerfil.reduce((a: number, c: any) => a + c.lucro, 0)).toBe(r.body.atual.lucro);
    expect(r.body.projecao.lucro).toHaveProperty("confianca");
    expect(r.body.metas).toMatchObject({ lucro: null, usos: null, disponivel: true });
  });

  it("metas: só ADMIN grava, valida, e o progresso aparece", async () => {
    expect((await request(app).put("/api/negocio/metas").set("authorization", `Bearer ${viewer}`).send({ lucro: 1000, usos: 10 })).status).toBe(403);
    expect((await request(app).put("/api/negocio/metas").set("authorization", `Bearer ${admin}`).send({ lucro: -5, usos: null })).status).toBe(400);
    const ok = await request(app).put("/api/negocio/metas").set("authorization", `Bearer ${admin}`).send({ lucro: 100000, usos: null });
    expect(ok.status).toBe(200);
    const r = await get("/api/negocio/financeiro");
    expect(r.body.metas).toMatchObject({ lucro: 100000, usos: null });
    expect(r.body.progresso.lucro.pct).toBeGreaterThan(0);
    expect(r.body.progresso.usos).toBeNull();
  });
});

describe("risco de abandono", () => {
  it("quem usou uma vez há 70 dias com saldo todo parado é risco alto; telefone mascarado; anonimizado fora", async () => {
    const r = await get("/api/negocio/risco?nivel=alto&limite=5");
    expect(r.status).toBe(200);
    expect(r.body.resumo.altos).toBeGreaterThanOrEqual(100);
    expect(r.body.clientes).toHaveLength(5);
    for (const c of r.body.clientes) {
      expect(c.nivel).toBe("alto");
      expect(c.telefone).toMatch(/^\*+\d{4}$/);
      expect(c.nome).not.toBe("Anonimizado");
      expect(c.diasSemUso).toBeGreaterThan(60);
    }
    const todos = await get("/api/negocio/risco?nivel=todos&limite=200");
    expect(todos.body.clientes.some((c: any) => c.nome === "Anonimizado")).toBe(false);
    expect((await get("/api/negocio/risco?nivel=zzz")).status).toBe(400);
  });

  it("audiência com mais de 90 ids (lista longa dividida para o D1) devolve só quem pode receber", async () => {
    const r = await get("/api/negocio/risco/audiencia?nivel=alto");
    expect(r.status).toBe(200);
    expect(r.body.total).toBeGreaterThanOrEqual(100);
    expect(r.body.autorizados).toBe(r.body.total);
    expect(r.body.clientIds).toHaveLength(r.body.autorizados);
    expect(r.body.clientIds).not.toContain(ids.anon);
    expect(r.body.mensagem).toContain("{{nome}}");
  });
});

describe("histórico: melhorou/caiu e tendência da fila (fases 1 e 2)", () => {
  it("o snapshot de hoje guarda as contagens das oportunidades e a comparação usa a foto mais antiga", async () => {
    // foto de 10 dias atrás: muito menos inativos e a base menor
    await runWithTenantContextAsync(tenantId, () =>
      prisma.dashboardSnapshot.create({
        data: {
          tenantId, day: new Date(`${diaBrtDe(new Date(agora - 10 * DIA))}T00:00:00.000Z`), totalClientes: 300, ativos: 150, inativos: 100, bloqueados: 0, semUso: 40,
          limiteTotal: 100000, valorUtilizado: 30000, saldoDisponivel: 70000, faixas: { INDEFINIDO: 0 }, oportunidades: { inativos: 20, semUso: 40, uso_71_99: 5 },
        },
      })
    );
    const ov = await get("/api/dashboard/overview?days=30");
    expect(ov.status).toBe(200);
    expect(ov.body.melhorouCaiu).not.toBeNull();
    expect(ov.body.melhorouCaiu.baseline.dias).toBe(10);
    expect(ov.body.melhorouCaiu.indisponivel).toBeNull();
    // hoje foi gravado com o JSON das oportunidades (o ensureTodaySnapshot roda no overview)
    const hoje = await runWithTenantContextAsync(tenantId, () => prisma.dashboardSnapshot.findFirst({ orderBy: { day: "desc" }, select: { oportunidades: true } }));
    expect(hoje?.oportunidades).toEqual(expect.objectContaining({ inativos: expect.any(Number), uso_0: expect.any(Number) }));

    const op = await get("/api/dashboard/oportunidades");
    expect(op.status).toBe(200);
    expect(op.body.historicoDisponivel).toBe(true);
    const inativos = op.body.itens.find((i: any) => i.key === "inativos");
    expect(inativos.tendencia).toMatchObject({ dias: 10, anterior: 20 });
    expect(["subiu", "caiu", "estavel"]).toContain(inativos.tendencia.direcao);
    // com filtro de cidade a tendência some (a foto é da base inteira)
    const filtrado = await get("/api/dashboard/oportunidades?cidade=Natal");
    expect(filtrado.body.historicoDisponivel).toBe(false);
    expect(filtrado.body.itens.every((i: any) => i.tendencia === null)).toBe(true);
  });
});

describe("assistente de dados (pela API inteira, com o modelo simulado)", () => {
  /** Modelo falso: no 1º passo pede TODAS as ferramentas de uma vez; no 2º responde. Guarda o que recebeu. */
  function modeloQueUsaTodas(entradas: Record<string, object> = {}) {
    const enviados: any[] = [];
    let passo = 0;
    const create = async (p: any) => {
      enviados.push(JSON.parse(JSON.stringify(p)));
      if (passo++ === 0) {
        return {
          stop_reason: "tool_use",
          content: NOMES_FERRAMENTAS.map((nome, i) => ({ type: "tool_use", id: `t${i}`, name: nome, input: entradas[nome] ?? {} })),
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      }
      return { stop_reason: "end_turn", content: [{ type: "text", text: "Resumo dos dados." }], usage: { input_tokens: 20, output_tokens: 8 } };
    };
    return { enviados, cliente: { beta: { messages: { create } } } };
  }
  const perguntar = (token: string) =>
    request(app).post("/api/assistente").set("authorization", `Bearer ${token}`).send({ mensagens: [{ role: "user", content: "Faça um relatório do mês" }] });

  // importados depois de definir o ambiente (o módulo de configuração falha sem JWT_SECRET)
  let NOMES_FERRAMENTAS: string[] = [];
  let _definirFabricaDeCliente: (f: () => any) => void = () => undefined;
  beforeAll(async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-teste";
    NOMES_FERRAMENTAS = (await import("../services/assistente/ferramentas")).NOMES_FERRAMENTAS;
    _definirFabricaDeCliente = (await import("./assistente"))._definirFabricaDeCliente;
  });

  it("todas as ferramentas rodam no SQLite, e o modelo só recebe fatos: sem projeção, sem estimativa, sem dado pessoal", async () => {
    const m = modeloQueUsaTodas({ contar_clientes: { cidade: ["Natal"], agruparPor: "statusConta" }, uso_por_hora: { tipo: "antecipacao", por: "cidade" } });
    _definirFabricaDeCliente(() => m.cliente);
    const r = await perguntar(admin);
    expect(r.status).toBe(200);
    expect(r.body.resposta).toBe("Resumo dos dados.");
    expect(r.body.ferramentas).toHaveLength(NOMES_FERRAMENTAS.length);
    expect(r.body.ferramentas.filter((c: any) => !c.ok)).toEqual([]);

    const resultados: { tool_use_id: string; content: string; is_error: boolean }[] = m.enviados[1].messages[2].content;
    expect(resultados).toHaveLength(NOMES_FERRAMENTAS.length);
    expect(resultados.some((x) => x.is_error)).toBe(false);
    const tudo = resultados.map((x) => x.content).join("\n");
    // nada de projeção, estimativa, risco ou horário sugerido
    expect(tudo).not.toMatch(/projecao|potencial10pct|clientesEmJogo|sugestao|lucroMensalEmRisco|"nota"|"nivel"/i);
    // nada de dado pessoal: nomes e telefones semeados não aparecem
    expect(tudo).not.toMatch(/Natal \d|Lagarto \d|Parado \d|Anonimizado|Sem Convenio|\+55849/);
    // mas os fatos estão lá
    const por = Object.fromEntries(resultados.map((x, i) => [NOMES_FERRAMENTAS[i], JSON.parse(x.content)]));
    expect(por.resumo_base.totalClientes).toBeGreaterThan(100);
    expect(por.contar_clientes).toMatchObject({ agrupadoPor: "statusConta" });
    expect(por.contar_clientes.total).toBe(41); // Natal: 40 + "Sem Convenio"; o anonimizado fica de fora
    expect(por.desempenho_cidades.cidades.find((c: any) => c.cidade === "Natal")).toMatchObject({ taxaUsoPct: expect.any(Number), variacaoPp: expect.any(Number) });
    expect(por.desempenho_convenios.convenios.find((c: any) => c.convenio === "Prefeitura de Natal").lucroAtual).toBe(300);
    expect(por.financeiro_mes.atual.lucro).toBeGreaterThanOrEqual(0);
    expect(por.financeiro_mes.projecao).toBeUndefined();
    expect(por.uso_por_hora.total.picoHora).toBe(10); // os 100 parados dominam o total (10h BRT)
    expect(por.uso_por_hora.segmentos.find((x: any) => x.chave === "natal").picoHora).toBe(12);
    expect(por.uso_por_hora.tempoMedidoEnvioAtePrimeiroUso).toMatchObject({ mediana_min: 40 });
    expect(por.fontes_de_dados.fontes.length).toBeGreaterThan(3);
    expect(por.campanhas_recentes.campanhas[0]).toMatchObject({ campanha: "Medição", enviadasOuAlem: 30 });
    expect(JSON.stringify(por.campanhas_recentes)).not.toMatch(/Oi|messageTemplate/);
  });

  it("a pergunta só é auditada como metadado, sem o texto", async () => {
    const m = modeloQueUsaTodas();
    _definirFabricaDeCliente(() => m.cliente);
    await perguntar(admin);
    const logs = await runWithTenantContextAsync(tenantId, () => prisma.auditLog.findMany({ where: { action: "ASSISTENTE_PERGUNTA" } }));
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain("relatório do mês");
  });

  it("acesso por área: quem só vê Base de clientes não recebe dados do Dashboard nem de Campanhas", async () => {
    const { signToken } = await import("../middleware/auth");
    const restrito = await runWithTenantContextAsync(tenantId, () =>
      prisma.user.create({ data: { tenantId, name: "Restrito", email: "restrito@negocio.test", passwordHash: "x", role: "OPERATOR", areasRestritas: true, areas: ["clients"] } })
    );
    const m = modeloQueUsaTodas();
    _definirFabricaDeCliente(() => m.cliente);
    const r = await perguntar(signToken({ id: restrito.id, tenantId, role: "OPERATOR", email: restrito.email }));
    expect(r.status).toBe(200);
    const porNome = Object.fromEntries(r.body.ferramentas.map((c: any) => [c.nome, c.ok]));
    expect(porNome.contar_clientes).toBe(true);
    expect(porNome.financeiro_mes).toBe(false);
    expect(porNome.desempenho_cidades).toBe(false);
    expect(porNome.campanhas_recentes).toBe(false);
    const negados = m.enviados[1].messages[2].content.filter((x: any) => x.is_error).map((x: any) => x.content);
    expect(negados.every((t: string) => /perfil de acesso/.test(t))).toBe(true);
  });

  it("outro tenant só recebe os próprios números", async () => {
    const { signToken } = await import("../middleware/auth");
    const ou = await withCrossTenantAccess(() => prisma.user.create({ data: { tenantId: outroTenantId, name: "O2", email: "o2@negocio.test", passwordHash: "x", role: "ADMIN" } }));
    const token = signToken({ id: ou.id, tenantId: outroTenantId, role: "ADMIN", email: ou.email });
    const m = modeloQueUsaTodas();
    _definirFabricaDeCliente(() => m.cliente);
    await perguntar(token);
    const resultados = m.enviados[1].messages[2].content;
    const resumo = JSON.parse(resultados[NOMES_FERRAMENTAS.indexOf("resumo_base")].content);
    expect(resumo.totalClientes).toBe(0);
  });
});

describe("acesso por área e isolamento", () => {
  it("rotas novas exigem login e outro tenant não enxerga estes números", async () => {
    expect((await request(app).get("/api/negocio/convenios")).status).toBe(401);
    const { signToken } = await import("../middleware/auth");
    const ou = await withCrossTenantAccess(() => prisma.user.create({ data: { tenantId: outroTenantId, name: "O", email: "o@negocio.test", passwordHash: "x", role: "ADMIN" } }));
    const t = signToken({ id: ou.id, tenantId: outroTenantId, role: "ADMIN", email: ou.email });
    const r = await get("/api/negocio/convenios", t);
    expect(r.status).toBe(200);
    expect(r.body.convenios).toEqual([]);
    expect((await get("/api/dashboard/cidades-desempenho", t)).body.disponivel).toBe(false);
  });
});

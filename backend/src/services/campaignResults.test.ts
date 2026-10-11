import {
  assignControlRefs,
  brasiliaDay,
  buildCampaignResults,
  buildCurve,
  buildLift,
  creditedUsage,
  EventEvaluation,
  evaluateEvents,
  loadCampaignEvaluations,
  saldoAsOf,
  saldoGroup,
  statsAtDay,
  UsageTx,
} from "./campaignResults";

// Horários em Brasília (UTC-3): "2026-10-05T10:00:00-03:00".
const at = (iso: string) => new Date(iso);

const tx = (confirmedAt: string, over: Partial<UsageTx> = {}): UsageTx => ({
  clientId: "c1",
  confirmedAt: at(confirmedAt),
  kind: "ANTECIPACAO",
  valorPrincipal: 310,
  juros: 46.5,
  ...over,
});

describe("brasiliaDay", () => {
  it("usa o dia de calendário de Brasília, não o de UTC", () => {
    // 02:30Z do dia 10 = 23:30 de Brasília do dia 9
    expect(brasiliaDay(at("2026-10-10T02:30:00Z"))).toBe(brasiliaDay(at("2026-10-09T12:00:00-03:00")));
    expect(brasiliaDay(at("2026-10-10T03:00:00Z"))).toBe(brasiliaDay(at("2026-10-10T00:00:00-03:00")));
  });
});

describe("creditedUsage", () => {
  const ref = at("2026-10-05T10:00:00-03:00");

  it("D0: uso no mesmo dia, depois do envio, conta; antes do envio não", () => {
    const out = creditedUsage(ref, [tx("2026-10-05T09:59:00-03:00"), tx("2026-10-05T15:00:00-03:00")], []);
    expect(out).toHaveLength(1);
    expect(out[0].dayOffset).toBe(0);
  });

  it("dia de calendário, não 24h: envio às 22h e uso à 01h do dia seguinte é D1", () => {
    const late = at("2026-10-05T22:00:00-03:00");
    const out = creditedUsage(late, [tx("2026-10-06T01:00:00-03:00")], []);
    expect(out[0].dayOffset).toBe(1);
  });

  it("janela de 30 dias de calendário: D30 entra, D31 não", () => {
    const out = creditedUsage(ref, [tx("2026-11-04T10:00:00-03:00"), tx("2026-11-05T10:00:00-03:00")], []);
    expect(out.map((o) => o.dayOffset)).toEqual([30]);
  });

  it("uso depois de outra campanha vai para a mais recente (não conta para esta)", () => {
    const other = at("2026-10-08T10:00:00-03:00");
    const out = creditedUsage(ref, [tx("2026-10-07T10:00:00-03:00"), tx("2026-10-09T10:00:00-03:00")], [other]);
    expect(out.map((o) => o.confirmedAt.toISOString())).toEqual([at("2026-10-07T10:00:00-03:00").toISOString()]);
  });

  it("campanha anterior a esta não rouba crédito (esta é a mais recente)", () => {
    const earlier = at("2026-10-01T10:00:00-03:00");
    expect(creditedUsage(ref, [tx("2026-10-06T10:00:00-03:00")], [earlier])).toHaveLength(1);
  });

  it("outra campanha no mesmo instante não rouba crédito", () => {
    expect(creditedUsage(ref, [tx("2026-10-06T10:00:00-03:00")], [ref])).toHaveLength(1);
  });

  it("devolve em ordem cronológica", () => {
    const out = creditedUsage(ref, [tx("2026-10-09T10:00:00-03:00"), tx("2026-10-06T10:00:00-03:00")], []);
    expect(out.map((o) => o.dayOffset)).toEqual([1, 4]);
  });
});

describe("saldoAsOf / saldoGroup", () => {
  const points = [
    { recordedAt: at("2026-10-01T09:00:00-03:00"), saldoDisponivel: 2000 },
    { recordedAt: at("2026-10-04T09:00:00-03:00"), saldoDisponivel: 0.01 },
    { recordedAt: at("2026-10-08T09:00:00-03:00"), saldoDisponivel: 1800 },
  ];

  it("é a última linha com recordedAt <= data do envio", () => {
    expect(saldoAsOf(points, at("2026-10-05T10:00:00-03:00"))).toBe(0.01);
    expect(saldoAsOf(points, at("2026-10-09T10:00:00-03:00"))).toBe(1800);
    expect(saldoAsOf(points, at("2026-10-01T09:00:00-03:00"))).toBe(2000);
  });

  it("sem histórico até a data do envio, o saldo é desconhecido (não zero)", () => {
    expect(saldoAsOf(points, at("2026-09-30T10:00:00-03:00"))).toBeNull();
    expect(saldoAsOf([], at("2026-10-05T10:00:00-03:00"))).toBeNull();
    expect(saldoAsOf(undefined, at("2026-10-05T10:00:00-03:00"))).toBeNull();
  });

  it("separa quem podia usar de quem não podia, e mantém o desconhecido à parte", () => {
    expect(saldoGroup(1500)).toBe("COM_SALDO");
    expect(saldoGroup(10)).toBe("COM_SALDO");
    expect(saldoGroup(1.56)).toBe("SEM_SALDO");
    expect(saldoGroup(0.01)).toBe("SEM_SALDO");
    expect(saldoGroup(null)).toBe("DESCONHECIDO");
  });
});

describe("assignControlRefs", () => {
  it("dá ao controle momentos de envios reais, na mesma distribuição de datas", () => {
    const treated = [at("2026-10-05T10:00:00Z"), at("2026-10-06T10:00:00Z"), at("2026-10-07T10:00:00Z"), at("2026-10-08T10:00:00Z")];
    const refs = assignControlRefs(treated, ["k1", "k2", "k3", "k4"]);
    expect([...refs.values()].map((d) => d.toISOString()).sort()).toEqual(treated.map((d) => d.toISOString()));
  });

  it("é determinístico (mesma entrada, mesma saída, independente da ordem dos ids)", () => {
    const treated = [at("2026-10-05T10:00:00Z"), at("2026-10-09T10:00:00Z")];
    const a = assignControlRefs(treated, ["b", "a", "c"]);
    const b = assignControlRefs(treated, ["c", "a", "b"]);
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
  });

  it("sem envios ainda, o controle fica sem referência", () => {
    expect(assignControlRefs([], ["k1"]).size).toBe(0);
  });
});

function ev(id: string, cohort: "TRATADO" | "CONTROLE", ref: string, over: Partial<EventEvaluation> = {}): EventEvaluation {
  return {
    id,
    clientId: id,
    variant: "A",
    cohort,
    ref: at(ref),
    saldoNoEnvio: 1000,
    grupoSaldo: "COM_SALDO",
    usos: [],
    primeiroUsoDia: null,
    ...over,
  };
}
const withUse = (e: EventEvaluation, dayOffset: number, kind: "ANTECIPACAO" | "COMPRA" = "ANTECIPACAO", principal = 310, juros = 46.5): EventEvaluation => ({
  ...e,
  usos: [...e.usos, { clientId: e.clientId, confirmedAt: e.ref, kind, valorPrincipal: principal, juros, dayOffset }],
  primeiroUsoDia: e.primeiroUsoDia === null ? dayOffset : Math.min(e.primeiroUsoDia, dayOffset),
});

describe("statsAtDay", () => {
  const REF = "2026-10-05T10:00:00-03:00";
  const evals = [
    withUse(ev("a", "TRATADO", REF), 0), // usou no D0
    withUse(ev("b", "TRATADO", REF), 5, "COMPRA", 45, 0), // usou no D5 (compra)
    ev("c", "TRATADO", REF), // não usou
    withUse(withUse(ev("d", "TRATADO", REF), 2), 20, "COMPRA", 100, 0), // D2 e D20
  ];

  it("é acumulado: cada dia inclui os anteriores", () => {
    expect(statsAtDay(evals, 0).convertidos).toBe(1);
    expect(statsAtDay(evals, 3).convertidos).toBe(2);
    expect(statsAtDay(evals, 7).convertidos).toBe(3);
    expect(statsAtDay(evals, 30).convertidos).toBe(3);
  });

  it("taxa = convertidos / envios (4)", () => {
    expect(statsAtDay(evals, 7).taxa).toBe(0.75);
  });

  it("separa antecipação (com lucro) de compra (lucro desconhecido, não somado)", () => {
    const s = statsAtDay(evals, 30);
    expect(s.antecipacoes).toEqual({ qtd: 2, valor: 620, lucro: 93 });
    expect(s.compras).toEqual({ qtd: 2, valor: 145 });
    expect(s.valorMovimentado).toBe(765);
    expect(s.lucro).toBe(93);
    expect(s.usos).toBe(4);
  });

  it("uma transação depois do horizonte não entra", () => {
    expect(statsAtDay(evals, 7).compras).toEqual({ qtd: 1, valor: 45 });
  });

  it("lista vazia: tudo zero, sem dividir por zero", () => {
    expect(statsAtDay([], 7)).toMatchObject({ n: 0, convertidos: 0, taxa: 0, lucro: 0 });
  });
});

describe("buildCurve", () => {
  it("marca quantos envios já completaram cada horizonte (ponto parcial)", () => {
    const now = at("2026-10-12T12:00:00-03:00"); // 7 dias depois do envio mais antigo
    const evals = [ev("a", "TRATADO", "2026-10-05T10:00:00-03:00"), ev("b", "TRATADO", "2026-10-11T10:00:00-03:00")];
    const curve = buildCurve(evals, now);
    expect(curve.map((p) => p.dia)).toEqual([0, 1, 3, 7, 14, 30]);
    const byDay = Object.fromEntries(curve.map((p) => [p.dia, p.maduros]));
    expect(byDay[0]).toBe(2);
    expect(byDay[1]).toBe(2);
    expect(byDay[3]).toBe(1);
    expect(byDay[7]).toBe(1);
    expect(byDay[14]).toBe(0);
  });
});

describe("evaluateEvents", () => {
  it("junta usos, saldo na data do envio e outras campanhas", () => {
    const ref = at("2026-10-05T10:00:00-03:00");
    const out = evaluateEvents({
      events: [{ id: "e1", clientId: "c1", variant: "A", cohort: "TRATADO", ref }],
      txByClient: new Map([["c1", [tx("2026-10-06T10:00:00-03:00"), tx("2026-10-12T10:00:00-03:00")]]]),
      otherRefsByClient: new Map([["c1", [at("2026-10-10T10:00:00-03:00")]]]),
      saldoByClient: new Map([["c1", [{ recordedAt: at("2026-10-01T09:00:00-03:00"), saldoDisponivel: 0.01 }]]]),
    });
    expect(out[0].usos).toHaveLength(1); // o de 12/10 foi para a campanha de 10/10
    expect(out[0].primeiroUsoDia).toBe(1);
    expect(out[0].grupoSaldo).toBe("SEM_SALDO");
  });

  it("cliente sem transações: sem uso e primeiroUsoDia nulo", () => {
    const out = evaluateEvents({
      events: [{ id: "e1", clientId: "c1", variant: "A", cohort: "TRATADO", ref: at("2026-10-05T10:00:00-03:00") }],
      txByClient: new Map(),
      otherRefsByClient: new Map(),
      saldoByClient: new Map(),
    });
    expect(out[0]).toMatchObject({ usos: [], primeiroUsoDia: null, grupoSaldo: "DESCONHECIDO" });
  });
});

describe("controle e lift", () => {
  const REF = "2026-10-05T10:00:00-03:00";
  // 200 tratados com 30% de uso; 200 controle com 10% — diferença grande e com amostra suficiente
  const treated = Array.from({ length: 200 }, (_, i) => (i < 60 ? withUse(ev(`t${i}`, "TRATADO", REF), 1) : ev(`t${i}`, "TRATADO", REF)));
  const control = Array.from({ length: 200 }, (_, i) => (i < 20 ? withUse(ev(`k${i}`, "CONTROLE", REF), 1) : ev(`k${i}`, "CONTROLE", REF)));

  it("lift em pontos percentuais e lucro incremental sobre o esperado pelo controle", () => {
    const lift = buildLift(treated, control).find((p) => p.dia === 7)!;
    expect(lift.taxaTratados).toBe(0.3);
    expect(lift.taxaControle).toBe(0.1);
    expect(lift.liftPontos).toBe(20);
    expect(lift.significativo95).toBe(true);
    expect(lift.dadosInsuficientes).toBe(false);
    // (60*46.5/200 - 20*46.5/200) * 200 = 40 * 46.5
    expect(lift.lucroIncremental).toBe(1860);
  });

  it("D0 sem ninguém usando: lift zero e não significativo", () => {
    const lift = buildLift(treated, control).find((p) => p.dia === 0)!;
    expect(lift.liftPontos).toBe(0);
    expect(lift.significativo95).toBe(false);
  });

  it("amostra pequena é sinalizada como insuficiente", () => {
    const lift = buildLift(treated.slice(0, 10), control.slice(0, 10)).find((p) => p.dia === 7)!;
    expect(lift.dadosInsuficientes).toBe(true);
  });

  it("buildCampaignResults sem controle não inventa comparação", () => {
    const r = buildCampaignResults(treated, at("2026-11-30T12:00:00-03:00"));
    expect(r.controle).toBeNull();
    expect(r.lift).toBeNull();
    expect(r.tratados.total).toHaveLength(6);
  });

  it("com controle: curvas separadas e lift sobre todos e sobre quem tinha saldo", () => {
    const r = buildCampaignResults([...treated, ...control], at("2026-11-30T12:00:00-03:00"));
    expect(r.controle?.total.find((p) => p.dia === 7)?.convertidos).toBe(20);
    expect(r.lift?.total.find((p) => p.dia === 7)?.liftPontos).toBe(20);
    expect(r.lift?.comSaldo.find((p) => p.dia === 7)?.liftPontos).toBe(20);
  });

  it("separa por saldo: quem estava sem saldo não dilui a taxa de quem podia usar", () => {
    const semSaldo = Array.from({ length: 100 }, (_, i) => ev(`s${i}`, "TRATADO", REF, { grupoSaldo: "SEM_SALDO", saldoNoEnvio: 0.01 }));
    const r = buildCampaignResults([...treated, ...semSaldo], at("2026-11-30T12:00:00-03:00"));
    expect(r.tratados.total.find((p) => p.dia === 7)?.taxa).toBeCloseTo(60 / 300);
    expect(r.tratados.porSaldo.COM_SALDO.find((p) => p.dia === 7)?.taxa).toBe(0.3);
    expect(r.tratados.porSaldo.SEM_SALDO.find((p) => p.dia === 7)?.taxa).toBe(0);
    expect(r.tratados.porSaldoN).toEqual({ COM_SALDO: 200, SEM_SALDO: 100, DESCONHECIDO: 0 });
  });
});

describe("loadCampaignEvaluations", () => {
  function fakePrisma(opts: { events: any[]; txs?: any[]; others?: any[]; snaps?: any[] }) {
    const calls: Record<string, any> = {};
    const prisma: any = {
      messageEvent: {
        findMany: jest.fn(async (args: any) => {
          // 1ª chamada: eventos da campanha; 2ª: envios de outras campanhas
          if (args.where.campaignId?.not) {
            calls.others = args;
            return opts.others ?? [];
          }
          calls.events = args;
          return opts.events;
        }),
      },
      purchase: {
        findMany: jest.fn(async (args: any) => {
          calls.tx = args;
          return opts.txs ?? [];
        }),
      },
      accountSnapshot: {
        findMany: jest.fn(async (args: any) => {
          calls.snaps = args;
          return opts.snaps ?? [];
        }),
      },
    };
    return { prisma, calls };
  }

  const sentEv = (id: string, clientId: string, sentAt: string, status = "ENVIADO") => ({
    id, clientId, variant: "A", status, sentAt: at(sentAt),
  });

  it("monta a avaliação a partir de transações, saldo histórico e outras campanhas", async () => {
    const { prisma, calls } = fakePrisma({
      events: [sentEv("e1", "c1", "2026-10-05T10:00:00-03:00")],
      txs: [
        { clientId: "c1", occurredAt: at("2026-10-06T10:00:00-03:00"), tipo: "Débito Pix Cartão", valorPrincipal: "310", juros: "46.5" },
        { clientId: "c1", occurredAt: at("2026-10-12T10:00:00-03:00"), tipo: "Compra à Vista Cartão Top Convênio", valorPrincipal: "45", juros: null },
        // não são uso do cliente: mensalidade e desconto de fatura em folha
        { clientId: "c1", occurredAt: at("2026-10-06T11:00:00-03:00"), tipo: "Assinatura AMEF-Gleebem", valorPrincipal: "29.9", juros: "0" },
        { clientId: "c1", occurredAt: at("2026-10-07T11:00:00-03:00"), tipo: "Débito de Fatura", valorPrincipal: "500", juros: null },
      ],
      others: [{ clientId: "c1", sentAt: at("2026-10-10T10:00:00-03:00") }],
      snaps: [{ clientId: "c1", recordedAt: at("2026-10-01T09:00:00-03:00"), saldoDisponivel: "1500" }],
    });

    const out = await loadCampaignEvaluations(prisma, "t1", "camp1");

    expect(out).toHaveLength(1);
    expect(out[0].usos).toHaveLength(1); // a compra de 12/10 é da campanha de 10/10; assinatura e fatura não são uso
    expect(out[0].usos[0]).toMatchObject({ kind: "ANTECIPACAO", valorPrincipal: 310, juros: 46.5, dayOffset: 1 });
    expect(out[0].saldoNoEnvio).toBe(1500);
    expect(out[0].grupoSaldo).toBe("COM_SALDO");

    // sempre escopado por tenant; o que conta como uso é decidido pelo classificador do tipo
    expect(calls.tx.where).toMatchObject({ tenantId: "t1" });
    expect(calls.snaps.where.tenantId).toBe("t1");
    // outras campanhas: do mesmo tenant e fora do sandbox
    expect(calls.others.where.campaign).toEqual({ tenantId: "t1", isSandbox: false });
    // eventos sem envio (fila/falha/bloqueado) nunca são consultados
    expect(calls.events.where.status.in).not.toContain("FILA");
    expect(calls.events.where.status.in).not.toContain("FALHA");
    expect(calls.events.where.status.in).not.toContain("BLOQUEADO");
  });

  it("o controle ganha o momento de um envio real e entra como CONTROLE", async () => {
    const { prisma } = fakePrisma({
      events: [
        sentEv("e1", "c1", "2026-10-05T10:00:00-03:00"),
        sentEv("e2", "c2", "2026-10-07T10:00:00-03:00"),
        { id: "k1", clientId: "c3", variant: "A", status: "CONTROLE", sentAt: null },
      ],
    });
    const out = await loadCampaignEvaluations(prisma, "t1", "camp1");
    const control = out.find((e) => e.id === "k1")!;
    expect(control.cohort).toBe("CONTROLE");
    expect([at("2026-10-05T10:00:00-03:00").getTime(), at("2026-10-07T10:00:00-03:00").getTime()]).toContain(control.ref.getTime());
    expect(out.filter((e) => e.cohort === "TRATADO")).toHaveLength(2);
  });

  it("controle sem nenhum envio ainda fica de fora (sem referência de data)", async () => {
    const { prisma } = fakePrisma({
      events: [{ id: "k1", clientId: "c3", variant: "A", status: "CONTROLE", sentAt: null }],
    });
    expect(await loadCampaignEvaluations(prisma, "t1", "camp1")).toEqual([]);
    expect(prisma.purchase.findMany).not.toHaveBeenCalled();
  });

  it("sem eventos enviados, não consulta o banco à toa", async () => {
    const { prisma } = fakePrisma({ events: [] });
    expect(await loadCampaignEvaluations(prisma, "t1", "camp1")).toEqual([]);
    expect(prisma.purchase.findMany).not.toHaveBeenCalled();
  });
});

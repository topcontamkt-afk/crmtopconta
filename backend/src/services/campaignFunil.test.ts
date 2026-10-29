import { montarFunil } from "./campaignFunil";

describe("montarFunil", () => {
  it("cada etapa soma o próprio status e os seguintes; taxas por etapa e sobre as enviadas", () => {
    const f = montarFunil({
      porStatus: { FILA: 10, ENVIADO: 5, ENTREGUE: 20, LIDO: 15, RESPONDIDO: 2, FALHA: 8, BLOQUEADO: 3, CONTROLE: 7 },
      cliquesPorStatus: { LIDO: 6, RESPONDIDO: 1 },
    });
    expect(f.publico).toBe(63); // tudo, menos o grupo de controle
    expect(f.naFila).toBe(10);
    expect(f.enviadas).toBe(42);
    expect(f.entregues).toBe(37);
    expect(f.visualizaram).toBe(17);
    expect(f.clicaram).toBe(7);
    expect(f.responderam).toBe(2);
    expect(f.falhas).toBe(8);
    expect(f.etapas.map((e) => e.chave)).toEqual(["publico", "enviadas", "entregues", "visualizaram", "clicaram"]);
    const ent = f.etapas.find((e) => e.chave === "entregues")!;
    expect(ent.pctDoAnterior).toBe(88.1); // 37 de 42
    expect(ent.pctDasEnviadas).toBe(88.1);
    expect(f.etapas.find((e) => e.chave === "clicaram")!.pctDoAnterior).toBe(41.2); // 7 de 17 que visualizaram
  });

  it("quem clicou conta como entregue e visualizou, mesmo sem recibo (o funil nunca tem mais cliques que visualizações)", () => {
    const f = montarFunil({ porStatus: { ENVIADO: 4, ENTREGUE: 2 }, cliquesPorStatus: { ENVIADO: 3, ENTREGUE: 1 } });
    expect(f.entregues).toBe(5); // 2 entregues + 3 que clicaram sem recibo
    expect(f.visualizaram).toBe(4); // 3 + 1
    expect(f.clicaram).toBe(4);
    expect(f.clicaram).toBeLessThanOrEqual(f.visualizaram);
    expect(f.visualizaram).toBeLessThanOrEqual(f.entregues);
    expect(f.entregues).toBeLessThanOrEqual(f.enviadas);
  });

  it("sem envios não divide por zero e usa o público da campanha quando ainda não há eventos", () => {
    const f = montarFunil({ porStatus: {}, cliquesPorStatus: {}, audienceCount: 195 });
    expect(f.publico).toBe(195);
    expect(f.enviadas).toBe(0);
    expect(f.etapas.every((e) => e.pctDoAnterior === null || Number.isFinite(e.pctDoAnterior))).toBe(true);
    expect(f.etapas.find((e) => e.chave === "enviadas")!.pctDoAnterior).toBe(0);
    expect(f.etapas.find((e) => e.chave === "entregues")!.pctDoAnterior).toBeNull();
  });

  it("a etapa 'usaram o limite' só entra quando calculada", () => {
    expect(montarFunil({ porStatus: { ENTREGUE: 10 }, cliquesPorStatus: {} }).etapas.some((e) => e.chave === "usaram")).toBe(false);
    const f = montarFunil({ porStatus: { ENTREGUE: 10 }, cliquesPorStatus: {}, usaram: 3 });
    const u = f.etapas.find((e) => e.chave === "usaram")!;
    expect(u.valor).toBe(3);
    expect(u.pctDasEnviadas).toBe(30);
    expect(u.pctDoAnterior).toBeNull();
  });
});

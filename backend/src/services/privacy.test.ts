/**
 * Supressão por titular (LGPD 02-03 / 02-06): telefone canônico, hash, gravação idempotente e consulta em lote.
 * Prisma falso em memória (mesmo padrão de retention.test.ts).
 */
import {
  canonicalPhone,
  contatoSuprimido,
  CONTATO_LIBERADO_WHERE,
  estaSuprimido,
  motivoBloqueioCliente,
  phoneHash,
  registrarOptOutTelefone,
  semSuprimidos,
  suprimidosEmLote,
  suprimir,
  variantesTelefone,
} from "./privacy";

const SALT = "salt-t1";

function fakePrisma(opts: { supressoes?: any[]; clientesOptOut?: any[]; destinatariosOptOut?: any[]; clientesTelefone?: any[] } = {}) {
  const supressoes: any[] = [...(opts.supressoes ?? [])];
  const calls: Record<string, any[]> = { clientUpdate: [], recipientUpdate: [] };
  const matches = (row: any, where: any) =>
    row.tenantId === where.tenantId &&
    (!where.motivo || row.motivo === where.motivo) &&
    (where.OR ?? [where]).some(
      (o: any) =>
        (o.phoneHash && (o.phoneHash.in ? o.phoneHash.in.includes(row.phoneHash) : o.phoneHash === row.phoneHash)) ||
        (o.docHash && (o.docHash.in ? o.docHash.in.includes(row.docHash) : o.docHash === row.docHash))
    );
  const prisma: any = {
    tenant: { findUnique: jest.fn(async () => ({ cpfSalt: SALT })) },
    supressaoTitular: {
      findMany: jest.fn(async ({ where }: any) => supressoes.filter((r) => matches(r, where))),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `s${supressoes.length + 1}`, ...data };
        supressoes.push(row);
        return { id: row.id };
      }),
    },
    client: {
      findMany: jest.fn(async ({ where }: any) => {
        if (where.optOutAt) return (opts.clientesOptOut ?? []).filter((c) => where.telefone.in.includes(c.telefone));
        return (opts.clientesTelefone ?? []).filter((c) => where.telefone.in.includes(c.telefone));
      }),
      updateMany: jest.fn(async (a: any) => void calls.clientUpdate.push(a)),
    },
    campaignRecipient: {
      findMany: jest.fn(async ({ where }: any) => (opts.destinatariosOptOut ?? []).filter((c) => where.telefone.in.includes(c.telefone))),
      updateMany: jest.fn(async (a: any) => void calls.recipientUpdate.push(a)),
    },
  };
  return { prisma, supressoes, calls };
}

describe("canonicalPhone", () => {
  it("as formas com e sem o nono dígito, com ou sem +55, viram o mesmo E.164 (com o 9)", () => {
    for (const p of ["+5584999998888", "5584999998888", "558499998888", "+558499998888", "84999998888", "(84) 99999-8888"]) {
      expect(canonicalPhone(p)).toBe("+5584999998888");
    }
  });
  it("fixo tem uma forma só; inválido é null; estrangeiro fica como veio", () => {
    expect(canonicalPhone("+558433334444")).toBe("+558433334444");
    expect(canonicalPhone("")).toBeNull();
    expect(canonicalPhone("abc")).toBeNull();
    expect(canonicalPhone("+14155552671")).toBe("+14155552671");
  });
  it("variantes cobrem as duas formas gravadas na base", () => {
    expect(variantesTelefone("558499998888").sort()).toEqual(["+558499998888", "+5584999998888"].sort());
  });
});

describe("phoneHash", () => {
  it("é estável entre as variantes do nono dígito e depende do salt do tenant", () => {
    const a = phoneHash(SALT, "+5584999998888");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(phoneHash(SALT, "558499998888")).toBe(a);
    expect(phoneHash("outro-salt", "+5584999998888")).not.toBe(a);
    expect(phoneHash(SALT, "xx")).toBeNull();
  });
});

describe("suprimir / estaSuprimido", () => {
  it("grava só o hash e é idempotente para o mesmo telefone e motivo", async () => {
    const { prisma, supressoes } = fakePrisma();
    const r1 = await suprimir(prisma, "t1", { telefone: "+5584999998888", motivo: "OPT_OUT", canal: "WHATSAPP", origem: "teste" });
    const r2 = await suprimir(prisma, "t1", { telefone: "558499998888", motivo: "OPT_OUT", canal: "SMS", origem: "teste" });
    expect(r1).toMatchObject({ criada: true });
    expect(r2).toMatchObject({ criada: false, id: r1!.id });
    expect(supressoes).toHaveLength(1);
    expect(JSON.stringify(supressoes[0])).not.toContain("99998888");
    expect(supressoes[0].telefone).toBeUndefined();
  });

  it("motivo diferente cria outra linha; sem telefone nem documento não faz nada", async () => {
    const { prisma, supressoes } = fakePrisma();
    await suprimir(prisma, "t1", { telefone: "+5584999998888", motivo: "OPT_OUT", origem: "x" });
    await suprimir(prisma, "t1", { telefone: "+5584999998888", motivo: "ELIMINACAO", origem: "x" });
    expect(supressoes).toHaveLength(2);
    expect(await suprimir(prisma, "t1", { telefone: "abc", motivo: "OPT_OUT", origem: "x" })).toBeNull();
  });

  it("estaSuprimido acha pelo telefone (qualquer forma) e pelo documento; outro tenant não enxerga", async () => {
    const { prisma } = fakePrisma();
    await suprimir(prisma, "t1", { telefone: "+5584999998888", motivo: "OPT_OUT", origem: "x" });
    await suprimir(prisma, "t1", { docHash: "doc-abc", motivo: "ELIMINACAO", origem: "x" });
    expect(await estaSuprimido(prisma, "t1", { telefone: "558499998888" })).toBe("OPT_OUT");
    expect(await estaSuprimido(prisma, "t1", { docHash: "doc-abc" })).toBe("ELIMINACAO");
    expect(await estaSuprimido(prisma, "t1", { telefone: "+5584988887777" })).toBeNull();
    expect(await estaSuprimido(prisma, "t2", { telefone: "+5584999998888" })).toBeNull();
  });
});

describe("suprimidosEmLote", () => {
  it("junta tabela de supressão e opt-out já gravado em qualquer cadastro/lista com o mesmo número", async () => {
    const { prisma } = fakePrisma({
      supressoes: [{ id: "s1", tenantId: "t1", phoneHash: phoneHash(SALT, "+5584911112222"), docHash: null, motivo: "OPT_OUT" }],
      clientesOptOut: [{ telefone: "+558433335555" }], // fixo, outro cadastro com opt-out
      destinatariosOptOut: [{ telefone: "+558477776666" }], // contato de lista, sem o 9
    });
    const lote = await suprimidosEmLote(prisma, "t1", { telefones: ["84911112222", "+558433335555", "+5584977776666", "+5584900000000", null] });
    expect([...lote.telefones].sort()).toEqual(["+558433335555", "+5584911112222", "+5584977776666"].sort());
    // poucas consultas para o lote todo (não uma por contato)
    expect(prisma.supressaoTitular.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.tenant.findUnique).toHaveBeenCalledTimes(1);
  });

  it("lote vazio não consulta nada", async () => {
    const { prisma } = fakePrisma();
    const lote = await suprimidosEmLote(prisma, "t1", { telefones: [null, ""] });
    expect(lote.telefones.size).toBe(0);
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });

  it("semSuprimidos tira da lista quem está suprimido por telefone ou documento", async () => {
    const { prisma } = fakePrisma({
      supressoes: [
        { id: "s1", tenantId: "t1", phoneHash: phoneHash(SALT, "+5584911112222"), docHash: null, motivo: "OPT_OUT" },
        { id: "s2", tenantId: "t1", phoneHash: null, docHash: "doc-x", motivo: "BLOQUEIO" },
      ],
    });
    const r = await semSuprimidos(prisma, "t1", [
      { id: "a", telefone: "+5584911112222", cpfHash: null },
      { id: "b", telefone: "+5584933334444", cpfHash: "doc-x" },
      { id: "c", telefone: "+5584955556666", cpfHash: "doc-y" },
    ]);
    expect(r.map((x) => x.id)).toEqual(["c"]);
  });
});

describe("registrarOptOutTelefone", () => {
  it("suprime o telefone e marca opt-out em TODOS os cadastros e destinatários com o número (sem sobrescrever a 1ª data)", async () => {
    const { prisma, supressoes, calls } = fakePrisma({ clientesTelefone: [{ id: "c1", telefone: "+5584999998888" }, { id: "c2", telefone: "+558499998888" }] });
    const r = await registrarOptOutTelefone(prisma, "t1", { telefone: "5584999998888", canal: "SMS", origem: "sms_webhook:twilio" });
    expect(r.clientIds).toEqual(["c1", "c2"]);
    expect(supressoes).toHaveLength(1);
    expect(supressoes[0]).toMatchObject({ motivo: "OPT_OUT", canal: "SMS", origem: "sms_webhook:twilio" });
    expect(calls.clientUpdate[0]).toMatchObject({ where: { tenantId: "t1", id: { in: ["c1", "c2"] } }, data: { autorizacaoComunicacao: false } });
    expect(calls.clientUpdate[1]).toMatchObject({ where: { optOutAt: null } });
    expect(calls.recipientUpdate[0].where).toMatchObject({ tenantId: "t1", optOutAt: null });
    expect(calls.recipientUpdate[0].where.telefone.in.sort()).toEqual(["+558499998888", "+5584999998888"].sort());
  });
});

describe("regras de cliente", () => {
  it("filtro de contato liberado inclui o bloqueio a pedido do titular", () => {
    expect(CONTATO_LIBERADO_WHERE).toEqual({ autorizacaoComunicacao: true, optOutAt: null, bloqueadoLgpdAt: null });
  });
  it("motivoBloqueioCliente", () => {
    expect(motivoBloqueioCliente({ autorizacaoComunicacao: true, optOutAt: null, bloqueadoLgpdAt: null })).toBeNull();
    expect(motivoBloqueioCliente({ autorizacaoComunicacao: false })).toMatch(/opt-out/);
    expect(motivoBloqueioCliente({ autorizacaoComunicacao: true, optOutAt: new Date() })).toMatch(/opt-out/);
    expect(motivoBloqueioCliente({ autorizacaoComunicacao: true, bloqueadoLgpdAt: new Date() })).toMatch(/bloqueado/);
    expect(motivoBloqueioCliente(null)).toBeNull();
  });
});

// LGPD 03-01 (correção): ELIMINACAO por telefone não pode fazer sumir o novo dono de um número reaproveitado
describe("ELIMINACAO por telefone x número reaproveitado", () => {
  const TEL = "+5584999998888";
  const supressoes = () => [{ id: "s1", tenantId: "t1", phoneHash: phoneHash(SALT, TEL), docHash: "doc-eliminado", motivo: "ELIMINACAO" }];

  it("contato com CPF próprio, diferente e não suprimido, passa", async () => {
    const { prisma } = fakePrisma({ supressoes: supressoes() });
    const lote = await suprimidosEmLote(prisma, "t1", { telefones: [TEL], docHashes: ["doc-novo"] });
    expect(contatoSuprimido(lote, { telefone: TEL, cpfHash: "doc-novo" })).toBe(false);
    expect(await estaSuprimido(prisma, "t1", { telefone: TEL, docHash: "doc-novo" })).toBeNull();
    const r = await semSuprimidos(prisma, "t1", [{ id: "novo-dono", telefone: TEL, cpfHash: "doc-novo" }]);
    expect(r.map((x) => x.id)).toEqual(["novo-dono"]);
  });

  it("contato de lista manual sem documento é barrado; o próprio documento eliminado também", async () => {
    const { prisma } = fakePrisma({ supressoes: supressoes() });
    const lote = await suprimidosEmLote(prisma, "t1", { telefones: [TEL], docHashes: ["doc-eliminado"] });
    expect(contatoSuprimido(lote, { telefone: TEL, cpfHash: null })).toBe(true);
    expect(contatoSuprimido(lote, { telefone: TEL, cpfHash: "doc-eliminado" })).toBe(true);
    expect(await estaSuprimido(prisma, "t1", { telefone: "558499998888" })).toBe("ELIMINACAO");
  });

  it("OPT_OUT e BLOQUEIO por telefone continuam bloqueando mesmo com CPF diferente", async () => {
    for (const motivo of ["OPT_OUT", "BLOQUEIO"]) {
      const { prisma } = fakePrisma({ supressoes: [...supressoes(), { id: "s2", tenantId: "t1", phoneHash: phoneHash(SALT, TEL), docHash: null, motivo }] });
      const lote = await suprimidosEmLote(prisma, "t1", { telefones: [TEL], docHashes: ["doc-novo"] });
      expect(contatoSuprimido(lote, { telefone: TEL, cpfHash: "doc-novo" })).toBe(true);
      expect(lote.motivos.get(TEL)).toBe(motivo);
    }
  });
});

import { Router } from "express";
import { z } from "zod";
import { prisma, tenantRaw } from "../config/db";
import { buscarEmPartes } from "../config/d1Partes";
import { antecipacaoSql, diaBrt, usoRealSql } from "../config/sql";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../middleware/audit";
import { avaliarConvenios } from "../services/convenioDesempenho";
import { avaliarFontes } from "../services/fontesFrescor";
import { avaliarFrescor } from "../services/dataFreshness";
import { todayBrt } from "../services/dashboardMetrics";
import { addDiasIso } from "../services/diasIso";
import { SEM_CIDADE } from "../services/cidades";
import { LIMITE_MAXIMO, PERFIL_LABELS } from "../services/rendaPerfil";
import { lerMetas, periodoDoMes, progressoMeta, projetarMes, variacaoPct } from "../services/financeiro";
import { intervaloNormal, NIVEL_ALTO, NIVEL_MEDIO, pontuarRisco, ResultadoRisco } from "../services/riscoAbandono";
import { cicloInfo, DiaCivil } from "../services/ciclos";
import { maskPhone } from "../services/masking";
import { ENVIAVEL_WHERE } from "../services/segments";
import { suggestedMessage } from "../services/opportunities";

/**
 * Visão de negócio: desempenho por convênio, frescor das fontes de dados, financeiro com metas e risco de
 * abandono. Tudo calculado de dados reais; o que não tem base volta marcado, não inventado. Dialeto do
 * SQLite/D1: dias de Brasília em texto ("YYYY-MM-DD", ver config/sql.ts), uso pela coluna `usoTipo` e a cidade
 * pela chave gravada em `Client.cidadeKey`. Cliente anonimizado ou com tratamento bloqueado (LGPD) fica fora de
 * toda estatística e lista, como no resto do dashboard.
 */
const router = Router();
router.use(requireAuth);

const SO_TRATAVEL = 'AND "anonymizedAt" IS NULL AND "bloqueadoLgpdAt" IS NULL';
const C_TRATAVEL = 'AND c."anonymizedAt" IS NULL AND c."bloqueadoLgpdAt" IS NULL';

async function ultimoDiaExtrato(tenantId: string): Promise<string | null> {
  const [r] = await tenantRaw.query<{ ultimo: string | null }[]>(
    `SELECT max(${diaBrt('"occurredAt"')}) AS ultimo FROM "Purchase" WHERE "tenantId" = $1`,
    tenantId
  );
  return r?.ultimo ?? null;
}

/**
 * GET /api/negocio/convenios — ranking de convênios (empresa conveniada): clientes, taxa de uso nos
 * 30 dias até o último dia do extrato contra os 30 anteriores, inativos, lucro (juros das antecipações)
 * e o potencial de reativar 10% dos inativos. Ver services/convenioDesempenho.ts.
 * O SQLite só baixa a caixa de letras ASCII: "EDUCAÇÃO" e "Educação" podem aparecer como dois convênios.
 */
router.get("/convenios", async (req, res) => {
  const { tenantId } = req.user!;
  const ultimo = await ultimoDiaExtrato(tenantId);

  const [clientes, semConv, uso] = await Promise.all([
    tenantRaw.query<{ chave: string; convenio: string; clientes: number; inativos: number }[]>(
      `SELECT lower(trim("empresaConveniada")) AS chave, MIN(trim("empresaConveniada")) AS convenio,
              SUM(CASE WHEN "limiteTotal" > 0 THEN 1 ELSE 0 END) AS clientes,
              SUM(CASE WHEN "limiteTotal" > 0 AND "statusConta" = 'INATIVO' THEN 1 ELSE 0 END) AS inativos
       FROM "Client" WHERE "tenantId" = $1 AND "empresaConveniada" IS NOT NULL AND trim("empresaConveniada") <> '' ${SO_TRATAVEL}
       GROUP BY 1`,
      tenantId
    ),
    tenantRaw.query<{ sem: number; total: number }[]>(
      `SELECT SUM(CASE WHEN "empresaConveniada" IS NULL OR trim("empresaConveniada") = '' THEN 1 ELSE 0 END) AS sem, COUNT(*) AS total
       FROM "Client" WHERE "tenantId" = $1 ${SO_TRATAVEL}`,
      tenantId
    ),
    ultimo
      ? tenantRaw.query<
          { chave: string; usaramAtual: number; usosAtual: number; usaramAnterior: number; usosAnterior: number; lucroAtual: number; lucroAnterior: number }[]
        >(
          `SELECT x.chave,
                  COUNT(DISTINCT x."clientId") FILTER (WHERE x.d BETWEEN $2 AND $3) AS "usaramAtual",
                  COUNT(*) FILTER (WHERE x.d BETWEEN $2 AND $3) AS "usosAtual",
                  COUNT(DISTINCT x."clientId") FILTER (WHERE x.d BETWEEN $4 AND $5) AS "usaramAnterior",
                  COUNT(*) FILTER (WHERE x.d BETWEEN $4 AND $5) AS "usosAnterior",
                  COALESCE(SUM(x.juros) FILTER (WHERE x.antec AND x.d BETWEEN $2 AND $3), 0) AS "lucroAtual",
                  COALESCE(SUM(x.juros) FILTER (WHERE x.antec AND x.d BETWEEN $4 AND $5), 0) AS "lucroAnterior"
           FROM (
             SELECT lower(trim(c."empresaConveniada")) AS chave, p."clientId", COALESCE(p."juros", 0) AS juros,
                    (p."usoTipo" = 'ANTECIPACAO') AS antec, ${diaBrt('p."occurredAt"')} AS d
             FROM "Purchase" p JOIN "Client" c ON c.id = p."clientId" AND c."tenantId" = p."tenantId"
             WHERE p."tenantId" = $1 AND ${usoRealSql("p")} AND c."empresaConveniada" IS NOT NULL AND trim(c."empresaConveniada") <> '' ${C_TRATAVEL}
           ) x
           WHERE x.d BETWEEN $4 AND $3
           GROUP BY 1`,
          tenantId,
          addDiasIso(ultimo, -29),
          ultimo,
          addDiasIso(ultimo, -59),
          addDiasIso(ultimo, -30)
        )
      : Promise.resolve([]),
  ]);

  const usoPor = new Map(uso.map((u) => [u.chave, u]));
  const resultado = avaliarConvenios(
    clientes.map((c) => {
      const u = usoPor.get(c.chave);
      return {
        chave: c.chave,
        convenio: c.convenio,
        clientes: c.clientes ?? 0,
        inativos: c.inativos ?? 0,
        usaramAtual: u?.usaramAtual ?? 0,
        usaramAnterior: u?.usaramAnterior ?? 0,
        usosAtual: u?.usosAtual ?? 0,
        usosAnterior: u?.usosAnterior ?? 0,
        lucroAtual: u?.lucroAtual ?? 0,
        lucroAnterior: u?.lucroAnterior ?? 0,
      };
    })
  );
  const frescor = ultimo ? avaliarFrescor(new Date(`${ultimo}T12:00:00-03:00`)) : null;
  const sem = semConv[0]?.sem ?? 0;
  const total = semConv[0]?.total ?? 0;
  res.json({
    disponivel: !!ultimo,
    ultimoDiaExtrato: ultimo,
    extratoEmDia: frescor ? frescor.status === "OK" : false,
    diasDefasagem: frescor?.diasDefasagem ?? null,
    semConvenio: { n: sem, pct: total > 0 ? Math.round((sem / total) * 1000) / 10 : 0 },
    ...resultado,
  });
});

/**
 * GET /api/negocio/fontes — há quantos dias cada fonte foi atualizada (extrato, planilha de contas,
 * snapshot diário) e as informativas (último disparo, última mensagem recebida). Ver services/fontesFrescor.ts.
 */
router.get("/fontes", async (req, res) => {
  const { tenantId } = req.user!;
  const [extrato, contas, disparo, mensagem, snapshot] = await Promise.all([
    tenantRaw
      .query<{ ultima: string | null }[]>(`SELECT max("occurredAt") AS ultima FROM "Purchase" WHERE "tenantId" = $1`, tenantId)
      .then((r) => (r[0]?.ultima ? new Date(r[0].ultima) : null)),
    prisma.importJob
      .findFirst({
        where: { status: { in: ["CONCLUIDO", "CONCLUIDO_COM_ERROS"] }, desfeitaEm: null, NOT: { formato: "compras" } },
        orderBy: { finishedAt: "desc" },
        select: { finishedAt: true },
      })
      .then((j) => j?.finishedAt ?? null),
    prisma.messageEvent
      .findFirst({
        where: { campaign: { isSandbox: false }, sentAt: { not: null }, status: { not: "CONTROLE" } },
        orderBy: { sentAt: "desc" },
        select: { sentAt: true },
      })
      .then((m) => m?.sentAt ?? null),
    prisma.conversation
      .findFirst({ where: { lastInboundAt: { not: null } }, orderBy: { lastInboundAt: "desc" }, select: { lastInboundAt: true } })
      .then((c) => c?.lastInboundAt ?? null),
    prisma.dashboardSnapshot.findFirst({ orderBy: { day: "desc" }, select: { day: true } }).then((s) => s?.day ?? null),
  ]);

  res.json({
    hoje: todayBrt().toISOString().slice(0, 10),
    fontes: avaliarFontes(
      [
        { key: "extrato", label: "Extrato de compras", descricao: "Última transação importada (aba Todas as Compras)", ultima: extrato, atencaoDias: null, desatualizadoDias: 3, acao: { label: "Importar extrato", destino: "/imports" } },
        { key: "contas", label: "Planilha de cartões e contas", descricao: "Última importação de clientes concluída", ultima: contas, atencaoDias: 7, desatualizadoDias: 14, acao: { label: "Importar clientes", destino: "/imports" } },
        { key: "snapshot", label: "Foto diária do dashboard", descricao: "Base do histórico e das tendências", ultima: snapshot, atencaoDias: 1, desatualizadoDias: 3 },
        { key: "disparo", label: "Último disparo de campanha", descricao: "Informativo: depende de haver campanhas", ultima: disparo, atencaoDias: null, desatualizadoDias: null },
        { key: "webhook", label: "Última mensagem recebida", descricao: "Informativo: WhatsApp (webhook da Meta)", ultima: mensagem, atencaoDias: null, desatualizadoDias: null },
      ],
      new Date()
    ),
  });
});

/** Compras de uso (antecipação e compra à vista) dos dois meses comparados, já marcadas como 'atual' ou 'anterior' ($2–$3 e $4–$5). */
const BASE_FINANCEIRO = `(
  SELECT y.*, CASE WHEN y.d BETWEEN $2 AND $3 THEN 'atual' WHEN y.d BETWEEN $4 AND $5 THEN 'anterior' END AS mes
  FROM (
    SELECT p."clientId", c."cidade", c."cidadeKey", c."limiteTotal", COALESCE(p."juros", 0) AS juros, p."valorPrincipal" AS valor,
           (p."usoTipo" = 'ANTECIPACAO') AS antec, ${diaBrt('p."occurredAt"')} AS d
    FROM "Purchase" p JOIN "Client" c ON c.id = p."clientId" AND c."tenantId" = p."tenantId"
    WHERE p."tenantId" = $1 AND ${usoRealSql("p")} ${C_TRATAVEL}
  ) y
) x`;

const sufixo = (m: "Atual" | "Anterior") => {
  const mes = m === "Atual" ? "atual" : "anterior";
  return `COUNT(*) FILTER (WHERE x.mes = '${mes}') AS "usos${m}",
          COUNT(*) FILTER (WHERE x.mes = '${mes}' AND x.antec) AS "antec${m}",
          COALESCE(SUM(x.juros) FILTER (WHERE x.mes = '${mes}' AND x.antec), 0) AS "lucro${m}",
          COALESCE(SUM(x.valor) FILTER (WHERE x.mes = '${mes}' AND x.antec), 0) AS "valor${m}",
          COUNT(DISTINCT x."clientId") FILTER (WHERE x.mes = '${mes}') AS "usaram${m}"`;
};

type Totais = Record<`${"usos" | "antec" | "lucro" | "valor" | "usaram"}${"Atual" | "Anterior"}`, number>;
const resumo = (t: Totais, m: "Atual" | "Anterior") => {
  const lucro = Number(t[`lucro${m}`] ?? 0);
  const antec = Number(t[`antec${m}`] ?? 0);
  const usaram = Number(t[`usaram${m}`] ?? 0);
  return {
    lucro: Math.round(lucro * 100) / 100,
    antecipacoes: antec,
    usos: Number(t[`usos${m}`] ?? 0),
    usaram,
    ticketMedio: antec > 0 ? Math.round((Number(t[`valor${m}`] ?? 0) / antec) * 100) / 100 : null,
    lucroPorUsuario: usaram > 0 ? Math.round((lucro / usaram) * 100) / 100 : null,
  };
};

/**
 * GET /api/negocio/financeiro — lucro (juros das antecipações) do mês do último extrato contra o mês
 * anterior até o mesmo dia, por semana, cidade e perfil de renda, com as metas e a projeção do
 * fechamento. Ver services/financeiro.ts.
 */
router.get("/financeiro", async (req, res) => {
  const { tenantId } = req.user!;
  const ultimo = await ultimoDiaExtrato(tenantId);
  const periodo = ultimo ? periodoDoMes(ultimo) : null;
  if (!ultimo || !periodo) return res.json({ disponivel: false, motivo: "SEM_EXTRATO" });

  const params = [tenantId, periodo.atual.de, periodo.atual.ate, periodo.anterior.de, periodo.anterior.ate];
  const perfilExpr = `(CASE WHEN x."limiteTotal" <= 0 THEN 'SEM_LIMITE' WHEN x."limiteTotal" <= ${LIMITE_MAXIMO.PF1} THEN 'PF1' WHEN x."limiteTotal" <= ${LIMITE_MAXIMO.PF2} THEN 'PF2' WHEN x."limiteTotal" <= ${LIMITE_MAXIMO.PF3} THEN 'PF3' ELSE 'PF4' END)`;

  const [totais, semanas, cidades, perfis, tenant] = await Promise.all([
    tenantRaw.query<Totais[]>(`SELECT ${sufixo("Atual")}, ${sufixo("Anterior")} FROM ${BASE_FINANCEIRO} WHERE x.mes IS NOT NULL`, ...params),
    tenantRaw.query<{ mes: string; semana: number; lucro: number }[]>(
      `SELECT x.mes, MIN(4, (CAST(strftime('%d', x.d) AS INTEGER) - 1) / 7 + 1) AS semana,
              COALESCE(SUM(x.juros) FILTER (WHERE x.antec), 0) AS lucro
       FROM ${BASE_FINANCEIRO} WHERE x.mes IS NOT NULL GROUP BY 1, 2`,
      ...params
    ),
    tenantRaw.query<{ chave: string; cidade: string; lucro: number }[]>(
      `SELECT x."cidadeKey" AS chave, MIN(trim(x."cidade")) AS cidade, COALESCE(SUM(x.juros) FILTER (WHERE x.antec), 0) AS lucro
       FROM ${BASE_FINANCEIRO} WHERE x.mes = 'atual' GROUP BY 1`,
      ...params
    ),
    tenantRaw.query<{ chave: string; lucro: number }[]>(
      `SELECT ${perfilExpr} AS chave, COALESCE(SUM(x.juros) FILTER (WHERE x.antec), 0) AS lucro
       FROM ${BASE_FINANCEIRO} WHERE x.mes = 'atual' GROUP BY 1`,
      ...params
    ),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { metas: true } }).catch(() => null),
  ]);

  const t = totais[0] ?? ({} as Totais);
  const atual = resumo(t, "Atual");
  const anterior = resumo(t, "Anterior");
  const frescor = avaliarFrescor(new Date(`${ultimo}T12:00:00-03:00`));
  const extratoEmDia = frescor.status === "OK";
  const metas = lerMetas(tenant?.metas);

  const pesoLucro = atual.lucro > 0 ? atual.lucro : 0;
  const fatia = (v: number) => (pesoLucro > 0 ? Math.round((v / pesoLucro) * 1000) / 10 : 0);
  const semanaDe = (mes: "atual" | "anterior", n: number) => Number(semanas.find((s) => s.mes === mes && Number(s.semana) === n)?.lucro ?? 0);

  res.json({
    disponivel: true,
    ultimoDiaExtrato: ultimo,
    extratoEmDia,
    diasDefasagem: frescor.diasDefasagem,
    periodo: { mes: periodo.mes, rotulo: periodo.rotulo, diaAtual: periodo.diaAtual, diasNoMes: periodo.diasNoMes },
    atual,
    anterior,
    variacoes: {
      lucro: variacaoPct(atual.lucro, anterior.lucro),
      antecipacoes: variacaoPct(atual.antecipacoes, anterior.antecipacoes),
      usos: variacaoPct(atual.usos, anterior.usos),
      ticketMedio: atual.ticketMedio !== null && anterior.ticketMedio !== null ? variacaoPct(atual.ticketMedio, anterior.ticketMedio) : null,
      lucroPorUsuario: atual.lucroPorUsuario !== null && anterior.lucroPorUsuario !== null ? variacaoPct(atual.lucroPorUsuario, anterior.lucroPorUsuario) : null,
    },
    semanas: [1, 2, 3, 4].map((n) => ({ semana: n, atual: Math.round(semanaDe("atual", n) * 100) / 100, anterior: Math.round(semanaDe("anterior", n) * 100) / 100 })),
    porCidade: cidades
      .filter((c) => c.chave !== SEM_CIDADE && Number(c.lucro) > 0)
      .sort((a, b) => Number(b.lucro) - Number(a.lucro))
      .slice(0, 8)
      .map((c) => ({ key: c.chave, cidade: c.cidade, lucro: Math.round(Number(c.lucro) * 100) / 100, pct: fatia(Number(c.lucro)) })),
    porPerfil: perfis
      .filter((p) => p.chave !== "SEM_LIMITE")
      .sort((a, b) => a.chave.localeCompare(b.chave))
      .map((p) => ({ key: p.chave, label: PERFIL_LABELS[p.chave as keyof typeof PERFIL_LABELS] ?? p.chave, lucro: Math.round(Number(p.lucro) * 100) / 100, pct: fatia(Number(p.lucro)) })),
    metas: { ...metas, disponivel: tenant !== null },
    progresso: { lucro: progressoMeta(atual.lucro, metas.lucro), usos: progressoMeta(atual.usos, metas.usos) },
    projecao: { lucro: projetarMes(atual.lucro, periodo.diaAtual, periodo.diasNoMes, extratoEmDia), usos: projetarMes(atual.usos, periodo.diaAtual, periodo.diasNoMes, extratoEmDia) },
  });
});

const metasSchema = z.object({
  lucro: z.number().positive().max(1e9).nullable(),
  usos: z.number().int().positive().max(1e9).nullable(),
});

/** PUT /api/negocio/metas — metas mensais de lucro (R$) e de usos. null remove a meta. */
router.put("/metas", requireRole("ADMIN"), async (req, res) => {
  const parsed = metasSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Metas inválidas" });
  const { tenantId, id: userId } = req.user!;
  await prisma.tenant.update({ where: { id: tenantId }, data: { metas: parsed.data } });
  await logAudit({ tenantId, userId, action: "UPDATE_TENANT_SETTINGS", target: "Tenant", targetId: tenantId, details: { metas: parsed.data } });
  res.json(parsed.data);
});

// ---------- Risco de abandono ----------

interface LinhaRisco {
  id: string;
  nome: string;
  telefone: string;
  cidade: string | null;
  limiteTotal: number;
  saldoDisponivel: number;
  diaCicloAbertura: number | null;
  usosTotal: number;
  usosUltimos90d: number;
  diasSemUso: number;
  ultimoUso: string;
  usos30: number;
  usos60Anteriores: number;
  lucro90: number;
  enviadas: number;
  respondeu: number;
}

const iso = (d: DiaCivil) => `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;

/** Pontua todos os clientes elegíveis (já usaram, têm limite) com o "agora" no último dia do extrato. */
async function carregarRisco(tenantId: string, ultimo: string, extratoEmDia: boolean) {
  const linhas = await tenantRaw.query<LinhaRisco[]>(
    `SELECT c.id, c."nome", c."telefone", c."cidade", c."limiteTotal" AS "limiteTotal", c."saldoDisponivel" AS "saldoDisponivel",
            c."diaCicloAbertura", c."usosTotal", c."usosUltimos90d",
            CAST(julianday($2) - julianday(${diaBrt('c."ultimoUsoReal"')}) AS INTEGER) AS "diasSemUso",
            ${diaBrt('c."ultimoUsoReal"')} AS "ultimoUso",
            COALESCE(u.u30, 0) AS usos30, COALESCE(u.u60, 0) AS "usos60Anteriores", COALESCE(u.lucro90, 0) AS lucro90,
            COALESCE(mm.enviadas, 0) AS enviadas, COALESCE(mm.respondeu, 0) AS respondeu
     FROM "Client" c
     LEFT JOIN (
       SELECT x."clientId",
              SUM(CASE WHEN x.d BETWEEN $3 AND $2 THEN 1 ELSE 0 END) AS u30,
              SUM(CASE WHEN x.d BETWEEN $4 AND $5 THEN 1 ELSE 0 END) AS u60,
              SUM(CASE WHEN x.antec THEN x.juros ELSE 0 END) AS lucro90
       FROM (
         SELECT p."clientId", COALESCE(p."juros", 0) AS juros, (p."usoTipo" = 'ANTECIPACAO') AS antec, ${diaBrt('p."occurredAt"')} AS d
         FROM "Purchase" p WHERE p."tenantId" = $1 AND ${usoRealSql("p")}
       ) x WHERE x.d BETWEEN $4 AND $2 GROUP BY 1
     ) u ON u."clientId" = c.id
     LEFT JOIN (
       SELECT m."clientId", COUNT(*) AS enviadas,
              SUM(CASE WHEN m."respondedAt" IS NOT NULL OR m."convertedAt" IS NOT NULL THEN 1 ELSE 0 END) AS respondeu
       FROM "MessageEvent" m JOIN "Campaign" cp ON cp.id = m."campaignId" AND cp."tenantId" = m."tenantId" AND cp."isSandbox" = 0
       WHERE m."tenantId" = $1 AND m."clientId" IS NOT NULL AND m."sentAt" IS NOT NULL AND m."status" <> 'CONTROLE'
         AND ${diaBrt('m."sentAt"')} >= $4
       GROUP BY 1
     ) mm ON mm."clientId" = c.id
     WHERE c."tenantId" = $1 AND c."limiteTotal" > 0 AND c."usosTotal" > 0 AND c."ultimoUsoReal" IS NOT NULL ${C_TRATAVEL}`,
    tenantId,
    ultimo,
    addDiasIso(ultimo, -29),
    addDiasIso(ultimo, -89),
    addDiasIso(ultimo, -30)
  );

  const [y, m, d] = ultimo.split("-").map(Number);
  const ref: DiaCivil = { y, m, d };
  const ciclos = new Map<number, { dias: number; abertura: string }>();
  const infoCiclo = (dia: number) => {
    let v = ciclos.get(dia);
    if (!v) {
      const i = cicloInfo(dia, ref);
      v = { dias: i.diasDesdeAbertura, abertura: iso(i.ultimaAbertura) };
      ciclos.set(dia, v);
    }
    return v;
  };

  return linhas
    .map((raw) => {
      const l: LinhaRisco = {
        ...raw,
        limiteTotal: Number(raw.limiteTotal),
        saldoDisponivel: Number(raw.saldoDisponivel),
        lucro90: Number(raw.lucro90),
        diasSemUso: Number(raw.diasSemUso),
        usos30: Number(raw.usos30),
        usos60Anteriores: Number(raw.usos60Anteriores),
        enviadas: Number(raw.enviadas),
        respondeu: Number(raw.respondeu),
      };
      const ciclo = l.diaCicloAbertura ? infoCiclo(l.diaCicloAbertura) : null;
      const r: ResultadoRisco = pontuarRisco(
        {
          limiteTotal: l.limiteTotal,
          saldoDisponivel: l.saldoDisponivel,
          diasSemUso: l.diasSemUso,
          usosTotal: l.usosTotal,
          usosUltimos90d: l.usosUltimos90d,
          usos30: l.usos30,
          usos60Anteriores: l.usos60Anteriores,
          diasDesdeAbertura: ciclo ? ciclo.dias : null,
          usouDesdeAbertura: ciclo ? l.ultimoUso >= ciclo.abertura : true,
          enviadas90d: l.enviadas,
          respondeu90d: l.respondeu,
        },
        extratoEmDia
      );
      return { l, r, lucroMensal: l.lucro90 / 3 };
    })
    .filter((x) => x.r.elegivel);
}

const riscoQuerySchema = z.object({
  nivel: z.enum(["alto", "medio", "todos"]).default("alto"),
  cidade: z.string().max(120).optional(),
  limite: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * GET /api/negocio/risco — clientes com maior risco de parar de usar (nota 0–100 por regras, ver
 * services/riscoAbandono.ts), o lucro mensal em risco e a distribuição por cidade. Telefone mascarado.
 */
router.get("/risco", async (req, res) => {
  const parsed = riscoQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Parâmetros inválidos" });
  const { nivel, cidade, limite } = parsed.data;
  const { tenantId } = req.user!;

  const ultimo = await ultimoDiaExtrato(tenantId);
  if (!ultimo) return res.json({ disponivel: false, motivo: "SEM_EXTRATO" });
  const frescor = avaliarFrescor(new Date(`${ultimo}T12:00:00-03:00`));
  const extratoEmDia = frescor.status === "OK";
  const todos = await carregarRisco(tenantId, ultimo, extratoEmDia);

  const altos = todos.filter((x) => x.r.nivel === "alto");
  const medios = todos.filter((x) => x.r.nivel === "medio");
  const porCidadeMap = new Map<string, { cidade: string; altos: number; avaliados: number }>();
  for (const x of todos) {
    const nome = x.l.cidade?.trim() || "Sem cidade";
    const g = porCidadeMap.get(nome.toLowerCase()) ?? { cidade: nome, altos: 0, avaliados: 0 };
    g.avaliados++;
    if (x.r.nivel === "alto") g.altos++;
    porCidadeMap.set(nome.toLowerCase(), g);
  }
  const filtrados = todos
    .filter((x) => (nivel === "todos" ? x.r.nivel !== "baixo" : x.r.nivel === nivel))
    .filter((x) => !cidade || (x.l.cidade ?? "").trim().toLowerCase() === cidade.trim().toLowerCase())
    .sort((a, b) => b.r.nota - a.r.nota || b.lucroMensal - a.lucroMensal);

  res.json({
    disponivel: true,
    ultimoDiaExtrato: ultimo,
    extratoEmDia,
    diasDefasagem: frescor.diasDefasagem,
    cortes: { alto: NIVEL_ALTO, medio: NIVEL_MEDIO },
    resumo: {
      avaliados: todos.length,
      altos: altos.length,
      medios: medios.length,
      lucroMensalEmRisco: Math.round(altos.reduce((a, x) => a + x.lucroMensal, 0)),
    },
    porCidade: [...porCidadeMap.values()]
      .filter((c) => c.altos > 0)
      .sort((a, b) => b.altos - a.altos)
      .slice(0, 8)
      .map((c) => ({ ...c, pct: Math.round((c.altos / c.avaliados) * 100) })),
    clientes: filtrados.slice(0, limite).map((x) => ({
      id: x.l.id,
      nome: x.l.nome,
      telefone: maskPhone(x.l.telefone),
      cidade: x.l.cidade,
      nota: x.r.nota,
      nivel: x.r.nivel,
      principal: x.r.principal,
      motivos: x.r.motivos,
      confianca: x.r.confianca,
      diasSemUso: x.l.diasSemUso,
      intervaloNormalDias: intervaloNormal(x.l.usosUltimos90d).dias,
      saldoDisponivel: x.l.saldoDisponivel,
      lucroMensal: Math.round(x.lucroMensal * 100) / 100,
    })),
    totalFiltrado: filtrados.length,
  });
});

/** GET /api/negocio/risco/audiencia?nivel= — ids (até 5000) de quem pode receber campanha, para "Criar campanha com esta lista". */
router.get("/risco/audiencia", async (req, res) => {
  const nivel = req.query.nivel === "medio" ? "medio" : req.query.nivel === "todos" ? "todos" : "alto";
  const { tenantId } = req.user!;
  const ultimo = await ultimoDiaExtrato(tenantId);
  if (!ultimo) return res.json({ total: 0, autorizados: 0, clientIds: [], mensagem: null });
  const extratoEmDia = avaliarFrescor(new Date(`${ultimo}T12:00:00-03:00`)).status === "OK";
  const todos = await carregarRisco(tenantId, ultimo, extratoEmDia);
  const ids = todos
    .filter((x) => (nivel === "todos" ? x.r.nivel !== "baixo" : x.r.nivel === nivel))
    .sort((a, b) => b.r.nota - a.r.nota)
    .slice(0, 5000)
    .map((x) => x.l.id);
  // `in` longo é dividido em pedaços que cabem no limite de parâmetros do D1 (config/d1Partes.ts).
  const aptos = ids.length
    ? await buscarEmPartes(
        { tenantId, id: { in: ids }, autorizacaoComunicacao: true, optOutAt: null, anonymizedAt: null, bloqueadoLgpdAt: null, ...ENVIAVEL_WHERE },
        (where) => prisma.client.findMany({ where, select: { id: true } })
      )
    : [];
  res.json({ total: ids.length, autorizados: aptos.length, clientIds: aptos.map((a) => a.id), mensagem: suggestedMessage("inativos") ?? null });
});

export default router;

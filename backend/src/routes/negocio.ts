import { Router } from "express";
import { z } from "zod";
import { prisma, tenantRaw } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../middleware/audit";
import { avaliarConvenios } from "../services/convenioDesempenho";
import { avaliarFontes } from "../services/fontesFrescor";
import { avaliarFrescor } from "../services/dataFreshness";
import { USO_TIPO_SQL } from "../services/usageRefresh";
import { todayBrt } from "../services/dashboardMetrics";
import { cidadeKeySql, SEM_CIDADE } from "../services/cidades";
import { LIMITE_MAXIMO, PERFIL_LABELS } from "../services/rendaPerfil";
import { lerMetas, periodoDoMes, progressoMeta, projetarMes, variacaoPct } from "../services/financeiro";
import { intervaloNormal, NIVEL_ALTO, NIVEL_MEDIO, pontuarRisco, ResultadoRisco } from "../services/riscoAbandono";
import { cicloInfo, DiaCivil } from "../services/ciclos";
import { maskPhone } from "../services/masking";
import { ENVIAVEL_WHERE } from "../services/segments";
import { suggestedMessage } from "../services/opportunities";

/**
 * Visão de negócio: desempenho por convênio, frescor das fontes de dados e (nas próximas rotas)
 * financeiro e risco. Tudo calculado de dados reais; o que não tem base volta marcado, não inventado.
 */
const router = Router();
router.use(requireAuth);

const ANTECIPACAO_SQL = `p."tipo" ~* '^\\s*d[eé]bito\\s+pix'`;
const USO_SQL = USO_TIPO_SQL.replace(/"tipo"/g, 'p."tipo"');
const CONVENIO_KEY = (col: string) => `lower(btrim(${col}))`;

async function ultimoDiaExtrato(tenantId: string): Promise<string | null> {
  const [r] = await tenantRaw.query<{ ultimo: string | null }[]>(
    `SELECT to_char(max(("occurredAt" AT TIME ZONE 'America/Sao_Paulo')::date), 'YYYY-MM-DD') AS ultimo FROM "Purchase" WHERE "tenantId" = $1`,
    tenantId
  );
  return r?.ultimo ?? null;
}

/**
 * GET /api/negocio/convenios — ranking de convênios (empresa conveniada): clientes, taxa de uso nos
 * 30 dias até o último dia do extrato contra os 30 anteriores, inativos, lucro (juros das antecipações)
 * e o potencial de reativar 10% dos inativos. Ver services/convenioDesempenho.ts.
 */
export async function dadosConvenios(tenantId: string) {
  const ultimo = await ultimoDiaExtrato(tenantId);

  const [clientes, semConv, uso] = await Promise.all([
    tenantRaw.query<{ key: string; convenio: string; clientes: number; inativos: number }[]>(
      `SELECT ${CONVENIO_KEY('"empresaConveniada"')} AS key,
              mode() WITHIN GROUP (ORDER BY btrim("empresaConveniada")) AS convenio,
              COUNT(*) FILTER (WHERE "limiteTotal" > 0)::int AS clientes,
              COUNT(*) FILTER (WHERE "limiteTotal" > 0 AND "statusConta"::text = 'INATIVO')::int AS inativos
       FROM "Client" WHERE "tenantId" = $1 AND "empresaConveniada" IS NOT NULL AND btrim("empresaConveniada") <> ''
       GROUP BY 1`,
      tenantId
    ),
    tenantRaw.query<{ sem: number; total: number }[]>(
      `SELECT COUNT(*) FILTER (WHERE "empresaConveniada" IS NULL OR btrim("empresaConveniada") = '')::int AS sem, COUNT(*)::int AS total
       FROM "Client" WHERE "tenantId" = $1`,
      tenantId
    ),
    ultimo
      ? tenantRaw.query<
          { key: string; usaramAtual: number; usosAtual: number; usaramAnterior: number; usosAnterior: number; lucroAtual: number; lucroAnterior: number }[]
        >(
          `SELECT x.key,
                  COUNT(DISTINCT x."clientId") FILTER (WHERE x.d BETWEEN $2::date - 29 AND $2::date)::int AS "usaramAtual",
                  COUNT(*) FILTER (WHERE x.d BETWEEN $2::date - 29 AND $2::date)::int AS "usosAtual",
                  COUNT(DISTINCT x."clientId") FILTER (WHERE x.d BETWEEN $2::date - 59 AND $2::date - 30)::int AS "usaramAnterior",
                  COUNT(*) FILTER (WHERE x.d BETWEEN $2::date - 59 AND $2::date - 30)::int AS "usosAnterior",
                  COALESCE(SUM(x.juros) FILTER (WHERE x.antec AND x.d BETWEEN $2::date - 29 AND $2::date), 0)::float AS "lucroAtual",
                  COALESCE(SUM(x.juros) FILTER (WHERE x.antec AND x.d BETWEEN $2::date - 59 AND $2::date - 30), 0)::float AS "lucroAnterior"
           FROM (
             SELECT ${CONVENIO_KEY('c."empresaConveniada"')} AS key, p."clientId", COALESCE(p."juros", 0) AS juros,
                    (${ANTECIPACAO_SQL}) AS antec, (p."occurredAt" AT TIME ZONE 'America/Sao_Paulo')::date AS d
             FROM "Purchase" p JOIN "Client" c ON c.id = p."clientId" AND c."tenantId" = p."tenantId"
             WHERE p."tenantId" = $1 AND (${USO_SQL}) AND c."empresaConveniada" IS NOT NULL AND btrim(c."empresaConveniada") <> ''
           ) x
           WHERE x.d BETWEEN $2::date - 59 AND $2::date
           GROUP BY 1`,
          tenantId,
          ultimo
        )
      : Promise.resolve([]),
  ]);

  const usoPor = new Map(uso.map((u) => [u.key, u]));
  const resultado = avaliarConvenios(
    clientes.map((c) => {
      const u = usoPor.get(c.key);
      return {
        chave: c.key,
        convenio: c.convenio,
        clientes: c.clientes,
        inativos: c.inativos,
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
  const { sem = 0, total = 0 } = semConv[0] ?? {};
  return ({
    disponivel: !!ultimo,
    ultimoDiaExtrato: ultimo,
    extratoEmDia: frescor ? frescor.status === "OK" : false,
    diasDefasagem: frescor?.diasDefasagem ?? null,
    semConvenio: { n: sem, pct: total > 0 ? Math.round((sem / total) * 1000) / 10 : 0 },
    ...resultado,
  });
}

router.get("/convenios", async (req, res) => res.json(await dadosConvenios(req.user!.tenantId)));

/**
 * GET /api/negocio/fontes — há quantos dias cada fonte foi atualizada (extrato, planilha de contas,
 * snapshot diário) e as informativas (último disparo, última mensagem recebida). Ver services/fontesFrescor.ts.
 */
export async function dadosFontes(tenantId: string) {
  const [extrato, contas, disparo, mensagem, snapshot] = await Promise.all([
    tenantRaw
      .query<{ ultima: Date | null }[]>(`SELECT max("occurredAt") AS ultima FROM "Purchase" WHERE "tenantId" = $1`, tenantId)
      .then((r) => r[0]?.ultima ?? null),
    prisma.importJob
      .findFirst({
        where: { tenantId, status: { in: ["CONCLUIDO", "CONCLUIDO_COM_ERROS"] }, desfeitaEm: null, NOT: { formato: "compras" } },
        orderBy: { finishedAt: "desc" },
        select: { finishedAt: true },
      })
      .then((j) => j?.finishedAt ?? null),
    prisma.messageEvent
      .findFirst({
        where: { campaign: { tenantId, isSandbox: false }, sentAt: { not: null }, status: { not: "CONTROLE" } },
        orderBy: { sentAt: "desc" },
        select: { sentAt: true },
      })
      .then((m) => m?.sentAt ?? null),
    prisma.conversation
      .findFirst({ where: { tenantId, lastInboundAt: { not: null } }, orderBy: { lastInboundAt: "desc" }, select: { lastInboundAt: true } })
      .then((c) => c?.lastInboundAt ?? null),
    prisma.dashboardSnapshot
      .findFirst({ where: { tenantId }, orderBy: { day: "desc" }, select: { day: true } })
      .then((s) => s?.day ?? null),
  ]);

  const agora = new Date();
  return ({
    hoje: todayBrt().toISOString().slice(0, 10),
    fontes: avaliarFontes(
      [
        { key: "extrato", label: "Extrato de compras", descricao: "Última transação importada (aba Todas as Compras)", ultima: extrato, atencaoDias: null, desatualizadoDias: 3, acao: { label: "Importar extrato", destino: "/imports" } },
        { key: "contas", label: "Planilha de cartões e contas", descricao: "Última importação de clientes concluída", ultima: contas, atencaoDias: 7, desatualizadoDias: 14, acao: { label: "Importar clientes", destino: "/imports" } },
        { key: "snapshot", label: "Foto diária do dashboard", descricao: "Base do histórico e das tendências", ultima: snapshot, atencaoDias: 1, desatualizadoDias: 3 },
        { key: "disparo", label: "Último disparo de campanha", descricao: "Informativo: depende de haver campanhas", ultima: disparo, atencaoDias: null, desatualizadoDias: null },
        { key: "webhook", label: "Última mensagem recebida", descricao: "Informativo: WhatsApp (webhook da Meta)", ultima: mensagem, atencaoDias: null, desatualizadoDias: null },
      ],
      agora
    ),
  });
}

router.get("/fontes", async (req, res) => res.json(await dadosFontes(req.user!.tenantId)));

/** Compras de uso (antecipação e compra à vista) dos dois meses comparados, já marcadas como 'atual' ou 'anterior'. */
const BASE_FINANCEIRO = `(
  SELECT p."clientId", c."cidade", c."limiteTotal", COALESCE(p."juros", 0) AS juros, p."valorPrincipal" AS valor,
         (${ANTECIPACAO_SQL}) AS antec,
         (p."occurredAt" AT TIME ZONE 'America/Sao_Paulo')::date AS d,
         CASE WHEN (p."occurredAt" AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date THEN 'atual'
              WHEN (p."occurredAt" AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $4::date AND $5::date THEN 'anterior' END AS mes
  FROM "Purchase" p JOIN "Client" c ON c.id = p."clientId" AND c."tenantId" = p."tenantId"
  WHERE p."tenantId" = $1 AND (${USO_SQL})
) x`;

const sufixo = (m: "Atual" | "Anterior") => {
  const mes = m === "Atual" ? "atual" : "anterior";
  return `COUNT(*) FILTER (WHERE x.mes = '${mes}')::int AS "usos${m}",
          COUNT(*) FILTER (WHERE x.mes = '${mes}' AND x.antec)::int AS "antec${m}",
          COALESCE(SUM(x.juros) FILTER (WHERE x.mes = '${mes}' AND x.antec), 0)::float AS "lucro${m}",
          COALESCE(SUM(x.valor) FILTER (WHERE x.mes = '${mes}' AND x.antec), 0)::float AS "valor${m}",
          COUNT(DISTINCT x."clientId") FILTER (WHERE x.mes = '${mes}')::int AS "usaram${m}"`;
};

type Totais = Record<`${"usos" | "antec" | "lucro" | "valor" | "usaram"}${"Atual" | "Anterior"}`, number>;
const resumo = (t: Totais, m: "Atual" | "Anterior") => {
  const lucro = t[`lucro${m}`];
  const antec = t[`antec${m}`];
  const usaram = t[`usaram${m}`];
  return {
    lucro: Math.round(lucro * 100) / 100,
    antecipacoes: antec,
    usos: t[`usos${m}`],
    usaram,
    ticketMedio: antec > 0 ? Math.round((t[`valor${m}`] / antec) * 100) / 100 : null,
    lucroPorUsuario: usaram > 0 ? Math.round((lucro / usaram) * 100) / 100 : null,
  };
};

/**
 * GET /api/negocio/financeiro — lucro (juros das antecipações) do mês do último extrato contra o mês
 * anterior até o mesmo dia, por semana, cidade e perfil de renda, com as metas e a projeção do
 * fechamento. Ver services/financeiro.ts.
 */
export async function dadosFinanceiro(tenantId: string) {
  const ultimo = await ultimoDiaExtrato(tenantId);
  const periodo = ultimo ? periodoDoMes(ultimo) : null;
  if (!ultimo || !periodo) return ({ disponivel: false, motivo: "SEM_EXTRATO" });

  const params = [tenantId, periodo.atual.de, periodo.atual.ate, periodo.anterior.de, periodo.anterior.ate];
  const perfilExpr = `(CASE WHEN x."limiteTotal" <= 0 THEN 'SEM_LIMITE' WHEN x."limiteTotal" <= ${LIMITE_MAXIMO.PF1} THEN 'PF1' WHEN x."limiteTotal" <= ${LIMITE_MAXIMO.PF2} THEN 'PF2' WHEN x."limiteTotal" <= ${LIMITE_MAXIMO.PF3} THEN 'PF3' ELSE 'PF4' END)`;

  const [totais, semanas, cidades, perfis, tenant] = await Promise.all([
    tenantRaw.query<Totais[]>(`SELECT ${sufixo("Atual")}, ${sufixo("Anterior")} FROM ${BASE_FINANCEIRO} WHERE x.mes IS NOT NULL`, ...params),
    tenantRaw.query<{ mes: string; semana: number; lucro: number }[]>(
      `SELECT x.mes, LEAST(4, (EXTRACT(DAY FROM x.d)::int - 1) / 7 + 1)::int AS semana,
              COALESCE(SUM(x.juros) FILTER (WHERE x.antec), 0)::float AS lucro
       FROM ${BASE_FINANCEIRO} WHERE x.mes IS NOT NULL GROUP BY 1, 2`,
      ...params
    ),
    tenantRaw.query<{ key: string; cidade: string; lucro: number }[]>(
      `SELECT ${cidadeKeySql('x."cidade"')} AS key, mode() WITHIN GROUP (ORDER BY x."cidade") AS cidade,
              COALESCE(SUM(x.juros) FILTER (WHERE x.antec), 0)::float AS lucro
       FROM ${BASE_FINANCEIRO} WHERE x.mes = 'atual' GROUP BY 1`,
      ...params
    ),
    tenantRaw.query<{ key: string; lucro: number }[]>(
      `SELECT ${perfilExpr} AS key, COALESCE(SUM(x.juros) FILTER (WHERE x.antec), 0)::float AS lucro
       FROM ${BASE_FINANCEIRO} WHERE x.mes = 'atual' GROUP BY 1`,
      ...params
    ),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { metas: true } }).catch(() => null),
  ]);

  const t = totais[0];
  const atual = resumo(t, "Atual");
  const anterior = resumo(t, "Anterior");
  const frescor = avaliarFrescor(new Date(`${ultimo}T12:00:00-03:00`));
  const extratoEmDia = frescor.status === "OK";
  const metas = lerMetas(tenant?.metas);

  const pesoLucro = atual.lucro > 0 ? atual.lucro : 0;
  const fatia = (v: number) => (pesoLucro > 0 ? Math.round((v / pesoLucro) * 1000) / 10 : 0);
  const semanaDe = (mes: "atual" | "anterior", n: number) => semanas.find((s) => s.mes === mes && s.semana === n)?.lucro ?? 0;

  return ({
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
      .filter((c) => c.key !== SEM_CIDADE && c.lucro > 0)
      .sort((a, b) => b.lucro - a.lucro)
      .slice(0, 8)
      .map((c) => ({ key: c.key, cidade: c.cidade, lucro: Math.round(c.lucro * 100) / 100, pct: fatia(c.lucro) })),
    porPerfil: perfis
      .filter((p) => p.key !== "SEM_LIMITE")
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((p) => ({ key: p.key, label: PERFIL_LABELS[p.key as keyof typeof PERFIL_LABELS] ?? p.key, lucro: Math.round(p.lucro * 100) / 100, pct: fatia(p.lucro) })),
    metas: { ...metas, disponivel: tenant !== null },
    progresso: { lucro: progressoMeta(atual.lucro, metas.lucro), usos: progressoMeta(atual.usos, metas.usos) },
    projecao: { lucro: projetarMes(atual.lucro, periodo.diaAtual, periodo.diasNoMes, extratoEmDia), usos: projetarMes(atual.usos, periodo.diaAtual, periodo.diasNoMes, extratoEmDia) },
  });
}

router.get("/financeiro", async (req, res) => res.json(await dadosFinanceiro(req.user!.tenantId)));

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
    `SELECT c.id, c."nome", c."telefone", c."cidade", c."limiteTotal"::float AS "limiteTotal", c."saldoDisponivel"::float AS "saldoDisponivel",
            c."diaCicloAbertura", c."usosTotal", c."usosUltimos90d",
            ($2::date - (c."ultimoUsoReal" AT TIME ZONE 'America/Sao_Paulo')::date)::int AS "diasSemUso",
            to_char((c."ultimoUsoReal" AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS "ultimoUso",
            COALESCE(u.u30, 0)::int AS usos30, COALESCE(u.u60, 0)::int AS "usos60Anteriores", COALESCE(u.lucro90, 0)::float AS lucro90,
            COALESCE(m.enviadas, 0)::int AS enviadas, COALESCE(m.respondeu, 0)::int AS respondeu
     FROM "Client" c
     LEFT JOIN (
       SELECT x."clientId",
              COUNT(*) FILTER (WHERE x.d BETWEEN $2::date - 29 AND $2::date) AS u30,
              COUNT(*) FILTER (WHERE x.d BETWEEN $2::date - 89 AND $2::date - 30) AS u60,
              SUM(x.juros) FILTER (WHERE x.antec AND x.d BETWEEN $2::date - 89 AND $2::date) AS lucro90
       FROM (
         SELECT p."clientId", COALESCE(p."juros", 0) AS juros, (${ANTECIPACAO_SQL}) AS antec,
                (p."occurredAt" AT TIME ZONE 'America/Sao_Paulo')::date AS d
         FROM "Purchase" p WHERE p."tenantId" = $1 AND (${USO_SQL})
       ) x WHERE x.d BETWEEN $2::date - 89 AND $2::date GROUP BY 1
     ) u ON u."clientId" = c.id
     LEFT JOIN (
       SELECT m."clientId", COUNT(*) AS enviadas,
              COUNT(*) FILTER (WHERE m."respondedAt" IS NOT NULL OR m."convertedAt" IS NOT NULL) AS respondeu
       FROM "MessageEvent" m JOIN "Campaign" cp ON cp.id = m."campaignId" AND cp."tenantId" = $1 AND cp."isSandbox" = false
       WHERE m."clientId" IS NOT NULL AND m."sentAt" IS NOT NULL AND m.status::text <> 'CONTROLE'
         AND (m."sentAt" AT TIME ZONE 'America/Sao_Paulo')::date >= $2::date - 89
       GROUP BY 1
     ) m ON m."clientId" = c.id
     WHERE c."tenantId" = $1 AND c."limiteTotal" > 0 AND c."usosTotal" > 0 AND c."ultimoUsoReal" IS NOT NULL`,
    tenantId,
    ultimo
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
    .map((l) => {
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
  const aptos = ids.length
    ? await prisma.client.findMany({ where: { tenantId, id: { in: ids }, autorizacaoComunicacao: true, optOutAt: null, ...ENVIAVEL_WHERE }, select: { id: true } })
    : [];
  res.json({ total: ids.length, autorizados: aptos.length, clientIds: aptos.map((a) => a.id), mensagem: suggestedMessage("inativos") ?? null });
});

export default router;

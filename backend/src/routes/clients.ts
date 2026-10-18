import { Request, Response, Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma, tenantRaw } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../middleware/audit";
import { buildSegmentWhere, SegmentFilters } from "../services/segments";
import { hashDocument, isValidDocument, maskPhone, normalizePhone } from "../services/masking";
import { relatorioTitular } from "../services/titular";
import { anonymizeClient, redigirAuditoria } from "../services/retention";
import { estaSuprimido, phoneHash, registrarOptOutTelefone } from "../services/privacy";
import { liberarEliminacao } from "../services/dedupe";
import { normalizeDocumentDigits } from "../services/purchaseParsing";

const router = Router();
router.use(requireAuth);

type Papel = "ADMIN" | "OPERATOR" | "ANALYST" | "VIEWER";
type Fonte = Record<string, unknown>;

/** LGPD 01-04: VIEWER não vê telefone completo nem e-mail (a decisão de need-to-know é da controladora). */
export const podeVerContato = (role: Papel) => role !== "VIEWER";

/** LGPD 01-04: listagem que passa desta profundidade (linhas já lidas) deixa trilha no AuditLog. */
export const LEITURA_VOLUME_LIMIAR = 50;

/** LGPD 01-04: só o que a tela Base de clientes usa. */
const LISTA_SELECT = {
  id: true,
  nome: true,
  telefone: true,
  cidade: true,
  percentualUtilizado: true,
  faixaUso: true,
  statusConta: true,
  autorizacaoComunicacao: true,
  bloqueadoLgpdAt: true,
} satisfies Prisma.ClientSelect;

/** LGPD 01-04: só o que a ficha usa (sem renda, nascimento, cpfHash nem campos de RH). */
const DETALHE_SELECT = {
  id: true,
  nome: true,
  telefone: true,
  email: true,
  cpfMasked: true,
  cidade: true,
  limiteTotal: true,
  valorUtilizado: true,
  saldoDisponivel: true,
  percentualUtilizado: true,
  faixaUso: true,
  statusConta: true,
  autorizacaoComunicacao: true,
  optOutAt: true,
  tags: true,
  bloqueadoLgpdAt: true,
  camposCorrigidos: true,
  anonymizedAt: true,
} satisfies Prisma.ClientSelect;

function comContatoPorPapel<T extends { telefone: string; email?: string | null }>(c: T, role: Papel) {
  if (podeVerContato(role)) return { ...c, telefoneMascarado: false };
  const { email: _e, ...resto } = c;
  return { ...resto, telefone: maskPhone(c.telefone), telefoneMascarado: true };
}

function lista(v: unknown): string[] | undefined {
  const itens = Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",") : [];
  const limpos = itens.map((s) => s.trim()).filter(Boolean);
  return limpos.length ? limpos : undefined;
}

function filtrosDe(src: Fonte, search?: string): SegmentFilters {
  const semUso = src.semUsoDiasMin !== undefined && src.semUsoDiasMin !== "" ? Number(src.semUsoDiasMin) : undefined;
  return {
    cidade: lista(src.cidade),
    faixaUso: lista(src.faixaUso),
    statusConta: lista(src.statusConta),
    autorizacaoComunicacao:
      src.autorizacao !== undefined && src.autorizacao !== "" ? src.autorizacao === true || src.autorizacao === "true" : undefined,
    semUsoDiasMin: semUso !== undefined && Number.isFinite(semUso) ? semUso : undefined,
    empresaConveniada: lista(src.empresaConveniada),
    search: search?.trim() || undefined,
  };
}

/** Escopo da leitura para o AuditLog: os filtros, nunca o termo de busca (pode ser nome ou telefone). */
function escopoDe(f: SegmentFilters) {
  const { search, ...resto } = f;
  const filtros = Object.fromEntries(Object.entries(resto).filter(([, v]) => v !== undefined));
  return { ...filtros, busca: !!search };
}

/** LGPD 03-04: cliente com tratamento suspenso sai da listagem padrão; só aparece com filtro explícito. */
type ModoBloqueio = "excluir" | "incluir" | "somente";
const modoBloqueio = (v: unknown): ModoBloqueio => (v === "incluir" || v === "somente" ? v : "excluir");

export function aplicarBloqueio(tenantId: string, base: Prisma.ClientWhereInput, modo: ModoBloqueio): Prisma.ClientWhereInput {
  if (modo === "incluir") return base;
  return { tenantId, AND: [base, { bloqueadoLgpdAt: modo === "somente" ? { not: null } : null }] };
}

/** LGPD 07-03: termo livre não vai na URL (logs de requisição). */
const BUSCA_NA_URL =
  "A busca por nome ou telefone não vai mais na URL (LGPD). Use POST /api/clients/search ou POST /api/clients/export.csv com o termo no corpo.";

function termoDoCorpo(body: Fonte): string | undefined {
  return typeof body.search === "string" ? body.search.slice(0, 120) : undefined;
}

async function listar(req: Request, res: Response, src: Fonte, search?: string) {
  const { tenantId, id: userId, role } = req.user!;
  const page = Math.max(1, Number(src.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(src.pageSize) || 25));
  const filtros = filtrosDe(src, search);
  const bloqueio = modoBloqueio(src.bloqueados);
  const where = aplicarBloqueio(tenantId, buildSegmentWhere(tenantId, filtros), bloqueio);
  const skip = (page - 1) * pageSize;

  const [rows, total] = await Promise.all([
    prisma.client.findMany({ where, orderBy: { updatedAt: "desc" }, skip, take: pageSize, select: LISTA_SELECT }),
    prisma.client.count({ where }),
  ]);
  const items = rows.map((c) => comContatoPorPapel(c, role));

  // LGPD 01-04: leitura em volume deixa trilha (escopo e quantidade, nunca os dados)
  if (skip + items.length > LEITURA_VOLUME_LIMIAR) {
    await logAudit({
      tenantId,
      userId,
      action: "READ_CLIENTS_BULK",
      target: "Client",
      details: { filtros: escopoDe(filtros), bloqueados: bloqueio, pagina: page, pageSize, quantidade: items.length, total },
    });
  }
  res.json({ items, total, page, pageSize });
}

/** GET /api/clients — lista com filtros não pessoais (cidade, faixa, status, autorização, paginação). */
router.get("/", async (req, res) => {
  if (req.query.search !== undefined) return res.status(400).json({ error: BUSCA_NA_URL });
  await listar(req, res, req.query as Fonte);
});

/** POST /api/clients/search — LGPD 07-03: mesma lista, com o termo de busca e os filtros no corpo. */
router.post("/search", async (req, res) => {
  const body = (req.body ?? {}) as Fonte;
  await listar(req, res, body, termoDoCorpo(body));
});

const CSV_HEADER = "nome,telefone,cpf_mascarado,cidade,percentual_utilizado,faixa_uso,status,autorizacao_comunicacao\n";

/**
 * Export CSV (Fase 2 — Should have). LGPD 05-01: telefone mascarado por padrão; completo só para ADMIN, com
 * motivo, e tudo auditado com filtros, quantidade e motivo. LGPD 03-04: cliente bloqueado nunca sai no arquivo.
 */
async function exportar(req: Request, res: Response, src: Fonte, search?: string) {
  const { tenantId, id: userId, role } = req.user!;
  const completo = src.completo === "1" || src.completo === "true" || src.completo === true;
  const motivo = typeof src.motivo === "string" ? src.motivo.trim().slice(0, 500) : "";
  if (completo && role !== "ADMIN") return res.status(403).json({ error: "Só administradores exportam o telefone completo" });
  if (completo && motivo.length < 5) return res.status(400).json({ error: "Informe o motivo para exportar o telefone completo" });

  const filtros = filtrosDe(src, search);
  const where = aplicarBloqueio(tenantId, buildSegmentWhere(tenantId, filtros), "excluir");
  const clients = await prisma.client.findMany({
    where,
    orderBy: { nome: "asc" },
    take: 50000,
    select: { nome: true, telefone: true, cpfMasked: true, cidade: true, percentualUtilizado: true, faixaUso: true, statusConta: true, autorizacaoComunicacao: true },
  });

  const rows = clients
    .map((c) =>
      [
        csvEscape(c.nome),
        completo ? c.telefone : maskPhone(c.telefone),
        c.cpfMasked,
        csvEscape(c.cidade || ""),
        Number(c.percentualUtilizado),
        c.faixaUso,
        c.statusConta,
        c.autorizacaoComunicacao ? "sim" : "nao",
      ].join(",")
    )
    .join("\n");

  await logAudit({
    tenantId,
    userId,
    action: "EXPORT_CLIENTS",
    target: "Client",
    details: {
      count: clients.length,
      filtros: escopoDe(filtros),
      telefoneCompleto: completo,
      ...(completo ? { motivo } : {}),
    },
  });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="clientes.csv"`);
  res.send(CSV_HEADER + rows);
}

/**
 * GET /api/clients/export.csv — export restrito por papel, só com filtros não pessoais na URL.
 * Precisa vir antes de "/:id" para não ser capturada como um id de cliente.
 */
router.get("/export.csv", requireRole("ADMIN", "OPERATOR", "ANALYST"), async (req, res) => {
  if (req.query.search !== undefined) return res.status(400).json({ error: BUSCA_NA_URL });
  await exportar(req, res, req.query as Fonte);
});

/** POST /api/clients/export.csv — LGPD 07-03: o mesmo export com termo de busca, motivo e filtros no corpo. */
router.post("/export.csv", requireRole("ADMIN", "OPERATOR", "ANALYST"), async (req, res) => {
  const body = (req.body ?? {}) as Fonte;
  await exportar(req, res, body, termoDoCorpo(body));
});

function csvEscape(value: string): string {
  // Neutraliza CSV/formula injection (OWASP): um valor vindo de import (ex.: nome de cliente)
  // começando com =/+/-/@ vira fórmula executável se o CSV for aberto no Excel/Sheets/LibreOffice
  // — prefixa com aspas simples antes do escaping normal para forçar interpretação como texto.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (safe.includes(",") || safe.includes('"') || safe.includes("\n")) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

router.get("/:id", async (req, res) => {
  const { tenantId, role } = req.user!;
  const client = await prisma.client.findFirst({
    where: { id: req.params.id, tenantId },
    select: {
      ...DETALHE_SELECT,
      movements: { orderBy: { data: "desc" }, take: 50, select: { id: true, tipo: true, valor: true, data: true } },
      // CONTROLE = fazia parte do público de uma campanha mas NÃO recebeu a mensagem: não é histórico de envio.
      messageEvents: {
        where: { status: { not: "CONTROLE" } },
        orderBy: { queuedAt: "desc" },
        take: 50,
        select: { id: true, channel: true, status: true, queuedAt: true, campaign: { select: { name: true } } },
      },
    },
  });
  if (!client) return res.status(404).json({ error: "Cliente não encontrado" });
  res.json(comContatoPorPapel(client, role));
});

/**
 * LGPD 03-02: relatório completo do titular (acesso e portabilidade, art. 18 II/V e art. 19 §3º), em JSON para
 * download. Só ADMIN; a geração fica no AuditLog com o tamanho de cada seção, sem os dados.
 */
router.get("/:id/relatorio-titular", requireRole("ADMIN"), async (req, res) => {
  const { tenantId, id: userId } = req.user!;
  const rel = await relatorioTitular(prisma, tenantId, req.params.id);
  if (!rel) return res.status(404).json({ error: "Cliente não encontrado" });
  await logAudit({
    tenantId,
    userId,
    action: "RELATORIO_TITULAR",
    target: "Client",
    targetId: req.params.id,
    details: {
      movimentacoes: rel.movimentacoes.length,
      historicoConta: rel.historicoConta.length,
      compras: rel.compras.length,
      mensagens: rel.mensagens.length,
      conversas: rel.conversas.length,
      listasManuais: rel.listasManuais.length,
      pedidos: rel.pedidos.length,
      suboperadores: rel.compartilhamento.suboperadores.map((s) => s.nome),
    },
  });
  res.setHeader("Content-Disposition", `attachment; filename="titular-${req.params.id.slice(0, 8)}.json"`);
  res.json(rel);
});

/** LGPD 03-04: suspende o tratamento (bloqueio do art. 18 IV); a data original é preservada se já estava bloqueado. */
router.post("/:id/bloqueio", requireRole("ADMIN"), async (req, res) => {
  const parsed = z.object({ pedidoId: z.string().uuid().optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Pedido inválido" });
  const { tenantId, id: userId } = req.user!;
  const existing = await prisma.client.findFirst({ where: { id: req.params.id, tenantId }, select: { id: true, bloqueadoLgpdAt: true } });
  if (!existing) return res.status(404).json({ error: "Cliente não encontrado" });
  if (parsed.data.pedidoId) {
    const pedido = await prisma.pedidoTitular.findFirst({ where: { id: parsed.data.pedidoId, tenantId }, select: { id: true } });
    if (!pedido) return res.status(404).json({ error: "Pedido do titular não encontrado" });
  }

  const bloqueadoLgpdAt = existing.bloqueadoLgpdAt ?? new Date();
  if (!existing.bloqueadoLgpdAt) await prisma.client.update({ where: { id: existing.id }, data: { bloqueadoLgpdAt } });
  await logAudit({
    tenantId,
    userId,
    action: "BLOQUEIO_LGPD",
    target: "Client",
    targetId: existing.id,
    details: { pedidoId: parsed.data.pedidoId ?? null, jaEstavaBloqueado: !!existing.bloqueadoLgpdAt },
  });
  res.json({ bloqueadoLgpdAt });
});

/** LGPD 03-04: retoma o tratamento (fim da suspensão). */
router.delete("/:id/bloqueio", requireRole("ADMIN"), async (req, res) => {
  const { tenantId, id: userId } = req.user!;
  const existing = await prisma.client.findFirst({ where: { id: req.params.id, tenantId }, select: { id: true, bloqueadoLgpdAt: true } });
  if (!existing) return res.status(404).json({ error: "Cliente não encontrado" });
  if (existing.bloqueadoLgpdAt) await prisma.client.update({ where: { id: existing.id }, data: { bloqueadoLgpdAt: null } });
  await logAudit({
    tenantId,
    userId,
    action: "DESBLOQUEIO_LGPD",
    target: "Client",
    targetId: existing.id,
    details: { estavaBloqueadoDesde: existing.bloqueadoLgpdAt?.toISOString() ?? null },
  });
  res.json({ bloqueadoLgpdAt: null });
});

const updateSchema = z.object({
  nome: z.string().trim().min(1).max(200).optional(),
  cidade: z.string().trim().max(120).optional(),
  // LGPD 03-03: correção de contato a pedido do titular
  telefone: z.string().max(30).optional(),
  email: z.string().trim().max(200).nullable().optional(),
  statusConta: z.enum(["ATIVO", "INATIVO", "BLOQUEADO"]).optional(),
  autorizacaoComunicacao: z.boolean().optional(),
  // LGPD 02-02: religar quem pediu para sair exige ADMIN e o motivo (ex.: novo consentimento registrado)
  motivoReautorizacao: z.string().trim().max(500).optional(),
  tags: z.array(z.string()).optional(),
});

/** LGPD 03-03: dados do titular que, corrigidos à mão, ficam travados contra a reimportação. */
export const CAMPOS_CORRIGIVEIS = ["nome", "cidade", "telefone", "email"] as const;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.patch("/:id", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const { tenantId, id: userId, role } = req.user!;
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { motivoReautorizacao, ...campos } = parsed.data;
  const data: Record<string, unknown> = { ...campos };
  // LGPD 03-03: telefone sempre em E.164; e-mail vazio limpa o campo
  if (parsed.data.telefone !== undefined) {
    const e164 = normalizePhone(parsed.data.telefone);
    if (!e164) return res.status(400).json({ error: "Telefone inválido" });
    data.telefone = e164;
  }
  if (parsed.data.email !== undefined) {
    const email = parsed.data.email ? parsed.data.email.toLowerCase() : null;
    if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: "E-mail inválido" });
    data.email = email;
  }

  const existing = await prisma.client.findFirst({ where: { id: req.params.id, tenantId } });
  if (!existing) return res.status(404).json({ error: "Cliente não encontrado" });
  if (existing.anonymizedAt) return res.status(409).json({ error: "Cliente anonimizado: os dados não podem mais ser alterados" });

  // LGPD 02-03: opt-out manual vale para o TELEFONE (supressão + todos os cadastros e listas com o número)
  let optOutRegistrado = false;
  if (parsed.data.autorizacaoComunicacao === false && existing.autorizacaoComunicacao) {
    await registrarOptOutTelefone(prisma, tenantId, { telefone: existing.telefone, canal: "MANUAL", origem: "operador" });
    data.optOutAt = existing.optOutAt ?? new Date();
    optOutRegistrado = true;
  }

  // LGPD 02-02: religar a comunicação de quem pediu para sair (opt-out neste cadastro ou pelo telefone/documento)
  let reautorizacao: { motivo: string; optOutDesde: string | null; supressoesRemovidas: number } | null = null;
  if (parsed.data.autorizacaoComunicacao === true && !existing.autorizacaoComunicacao) {
    const sup = await estaSuprimido(prisma, tenantId, { telefone: existing.telefone, docHash: existing.cpfHash });
    if (existing.bloqueadoLgpdAt || sup === "BLOQUEIO" || sup === "ELIMINACAO") {
      return res.status(409).json({ error: "Titular com bloqueio ou pedido de eliminação: a comunicação não pode ser religada" });
    }
    if (existing.optOutAt || sup === "OPT_OUT") {
      if (role !== "ADMIN") return res.status(403).json({ error: "Só administradores religam a comunicação de quem pediu para sair" });
      const motivo = motivoReautorizacao ?? "";
      if (motivo.length < 5) return res.status(400).json({ error: "Informe o motivo (ex.: novo consentimento do titular) para religar a comunicação" });
      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { cpfSalt: true } });
      const ph = tenant?.cpfSalt ? phoneHash(tenant.cpfSalt, existing.telefone) : null;
      const removidas = await prisma.supressaoTitular.deleteMany({
        where: { tenantId, motivo: "OPT_OUT", OR: [...(ph ? [{ phoneHash: ph }] : []), { docHash: existing.cpfHash }] },
      });
      reautorizacao = { motivo, optOutDesde: existing.optOutAt?.toISOString() ?? null, supressoesRemovidas: removidas.count };
    }
    data.optOutAt = null;
  }

  // LGPD 03-03: grava a trava ({ campo: data }) de cada dado do titular que de fato mudou
  const agora = new Date().toISOString();
  const corrigidos = CAMPOS_CORRIGIVEIS.filter((campo) => data[campo] !== undefined && (data[campo] ?? null) !== (existing[campo] ?? null));
  if (corrigidos.length) {
    const anteriores = (existing.camposCorrigidos && typeof existing.camposCorrigidos === "object" ? existing.camposCorrigidos : {}) as Record<string, string>;
    data.camposCorrigidos = { ...anteriores, ...Object.fromEntries(corrigidos.map((c) => [c, agora])) };
  }

  const updated = await prisma.client.update({ where: { id: existing.id }, data, select: DETALHE_SELECT });
  // Não loga valores: nome/telefone/e-mail são PII. Só quais campos vieram e quais ficaram travados — o valor
  // em si já vive na linha do Client (que a rotina de retenção em services/retention.ts anonimiza).
  await logAudit({
    tenantId,
    userId,
    action: "UPDATE_CLIENT",
    target: "Client",
    targetId: existing.id,
    details: { fieldsChanged: Object.keys(campos), camposCorrigidos: corrigidos, ...(optOutRegistrado ? { optOut: "MANUAL" } : {}) },
  });
  if (reautorizacao) {
    await logAudit({ tenantId, userId, action: "REAUTORIZACAO_COMUNICACAO", target: "Client", targetId: existing.id, details: reautorizacao });
  }
  res.json(updated);
});

/** POST /api/clients/bulk — ações em massa: tag ou bloqueio */
const bulkSchema = z.object({
  clientIds: z.array(z.string()).min(1),
  action: z.enum(["ADD_TAG", "REMOVE_TAG", "BLOCK", "OPT_OUT"]),
  tag: z.string().optional(),
});

router.post("/bulk", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const { tenantId, id: userId } = req.user!;
  const parsed = bulkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { clientIds, action, tag } = parsed.data;

  const clients = await prisma.client.findMany({ where: { id: { in: clientIds }, tenantId } });

  for (const c of clients) {
    if (action === "ADD_TAG" && tag) {
      await prisma.client.update({ where: { id: c.id }, data: { tags: { push: tag } } });
    } else if (action === "REMOVE_TAG" && tag) {
      await prisma.client.update({ where: { id: c.id }, data: { tags: c.tags.filter((t) => t !== tag) } });
    } else if (action === "BLOCK") {
      await prisma.client.update({ where: { id: c.id }, data: { statusConta: "BLOQUEADO" } });
    } else if (action === "OPT_OUT") {
      // LGPD 02-03: o opt-out manual vale para o telefone (supressão), não só para o cadastro
      await registrarOptOutTelefone(prisma, tenantId, { telefone: c.telefone, canal: "MANUAL", origem: "operador_em_massa" });
      await prisma.client.update({
        where: { id: c.id },
        data: { autorizacaoComunicacao: false, optOutAt: c.optOutAt ?? new Date() },
      });
    }
  }

  await logAudit({ tenantId, userId, action: `BULK_${action}`, target: "Client", details: { clientIds, tag } });
  res.json({ affected: clients.length });
});

/**
 * LGPD 03-01 / 04-01: eliminação dos dados de UM titular a pedido (art. 18, VI). Só ADMIN, com motivo e a frase de
 * confirmação. Grava a supressão por documento/telefone (a reimportação não recria o titular), anonimiza o
 * cliente e tudo o que se liga a ele (services/retention.ts) e audita sem PII. Se veio de um pedido de
 * eliminação aberto, o pedido fica atendido.
 */
export const CONFIRMA_ELIMINACAO = "ELIMINAR DADOS";
const anonSchema = z.object({
  motivo: z.string().trim().min(5).max(500),
  pedidoId: z.string().uuid().optional(),
  confirmacao: z.literal(CONFIRMA_ELIMINACAO),
});

router.post("/:id/anonymize", requireRole("ADMIN"), async (req, res) => {
  const parsed = anonSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: `Informe o motivo e confirme digitando: ${CONFIRMA_ELIMINACAO}` });
  const { tenantId, id: userId } = req.user!;
  const existing = await prisma.client.findFirst({ where: { id: req.params.id, tenantId }, select: { id: true, anonymizedAt: true } });
  if (!existing) return res.status(404).json({ error: "Cliente não encontrado" });
  if (existing.anonymizedAt) return res.status(409).json({ error: "Os dados deste cliente já foram eliminados" });
  const { motivo, pedidoId } = parsed.data;
  const pedido = pedidoId ? await prisma.pedidoTitular.findFirst({ where: { id: pedidoId, tenantId }, select: { id: true, tipo: true, status: true } }) : null;
  if (pedidoId && !pedido) return res.status(404).json({ error: "Pedido do titular não encontrado" });

  const r = await anonymizeClient(prisma, tenantId, existing.id, { motivo, origem: "PEDIDO_TITULAR", pedidoId: pedidoId ?? null, userId });
  if (!r) return res.status(404).json({ error: "Cliente não encontrado" });

  if (pedido && pedido.tipo === "ELIMINACAO" && pedido.status === "ABERTO") {
    await prisma.pedidoTitular.update({
      where: { id: pedido.id },
      data: { status: "ATENDIDO", respondidoEm: new Date(), resposta: "Dados eliminados (anonimização) no CRM." },
    });
  }
  res.json(r);
});

/**
 * LGPD 03-01: liberação manual da supressão por ELIMINACAO de um documento (ex.: o titular voltou a ser cliente e a
 * planilha não traz data de abertura nova). O CPF/CNPJ só é usado para calcular o hash, nunca é gravado nem logado.
 */
const liberarSchema = z.object({ cpf: z.string().min(1).max(30), motivo: z.string().trim().min(5).max(500) });

router.post("/supressao/liberar", requireRole("ADMIN"), async (req, res) => {
  const parsed = liberarSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Informe o CPF/CNPJ e o motivo" });
  const { tenantId, id: userId } = req.user!;
  const doc = normalizeDocumentDigits(parsed.data.cpf);
  if (!doc || !isValidDocument(doc)) return res.status(400).json({ error: "CPF/CNPJ inválido" });
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { cpfSalt: true } });
  if (!tenant?.cpfSalt) return res.status(500).json({ error: "Tenant sem salt" });
  const removidas = await liberarEliminacao(prisma, tenantId, hashDocument(doc, tenant.cpfSalt), { motivo: parsed.data.motivo, origem: "manual", userId });
  if (removidas === 0) return res.status(404).json({ error: "Não há supressão por eliminação para este documento" });
  res.json({ removidas });
});

/**
 * POST /api/clients/purge — "Limpar base": apaga TODOS os clientes do tenant. Usado para descartar uma base
 * importada por engano antes de reimportar. Irreversível, só ADMIN, exige a frase de confirmação.
 *
 * LGPD 04-05: apaga na ordem das chaves estrangeiras (compras e histórico de conta têm FK RESTRICT e antes
 * derrubavam tudo) e não deixa órfão com dado pessoal: as conversas da Inbox dos clientes (telefone, nome do
 * perfil, texto e mídia) são apagadas, os destinatários de listas manuais ligados a cliente são anonimizados,
 * e o estado de desfazer importação vai junto. Tudo numa transação só (um bloco no banco, com o tenant da
 * sessão: nada é interpolado). Antes, o opt-out e o bloqueio de cada cliente viram supressão por
 * telefone/documento, para a reimportação não religar ninguém (LGPD 02-02). Depois, a PII de AuditLog antigos
 * dos clientes é redigida sem quebrar a cadeia. Campanhas, segmentos, templates e o histórico de importações ficam.
 */
const PURGE_CONFIRMATION = "LIMPAR BASE";

export const PURGE_SQL = `DO $purge$
DECLARE t text := current_setting('app.tenant_id');
BEGIN
  DELETE FROM "WaMediaBlob" WHERE "tenantId" = t AND "messageId" IN (
    SELECT m."id" FROM "WaMessage" m JOIN "Conversation" c ON c."id" = m."conversationId" WHERE c."tenantId" = t AND c."clientId" IS NOT NULL);
  DELETE FROM "WaMessage" WHERE "tenantId" = t AND "conversationId" IN (SELECT "id" FROM "Conversation" WHERE "tenantId" = t AND "clientId" IS NOT NULL);
  DELETE FROM "Conversation" WHERE "tenantId" = t AND "clientId" IS NOT NULL;
  UPDATE "CampaignRecipient" SET "nome" = 'Contato anonimizado', "telefone" = 'anon-' || "id", "cpfHash" = NULL, "cpfMasked" = NULL,
    "limiteDisponivel" = NULL, "clientId" = NULL WHERE "tenantId" = t AND "clientId" IS NOT NULL;
  DELETE FROM "MessageEvent" WHERE "clientId" IN (SELECT "id" FROM "Client" WHERE "tenantId" = t);
  DELETE FROM "Movement" WHERE "clientId" IN (SELECT "id" FROM "Client" WHERE "tenantId" = t);
  DELETE FROM "AccountSnapshot" WHERE "tenantId" = t;
  DELETE FROM "Purchase" WHERE "tenantId" = t;
  DELETE FROM "ImportChange" WHERE "tenantId" = t;
  DELETE FROM "Notification" WHERE "tenantId" = t AND "relatedType" = 'Client';
  DELETE FROM "Client" WHERE "tenantId" = t;
END
$purge$;`;

/** LGPD 02-02: antes de apagar, o opt-out e o bloqueio de cada cliente viram supressão (só hashes), em lote. */
async function preservarSupressoes(tenantId: string): Promise<number> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { cpfSalt: true } });
  if (!tenant?.cpfSalt) return 0;
  const clientes = await prisma.client.findMany({
    where: { tenantId, anonymizedAt: null, OR: [{ optOutAt: { not: null } }, { bloqueadoLgpdAt: { not: null } }] },
    select: { telefone: true, cpfHash: true, optOutAt: true, bloqueadoLgpdAt: true },
  });
  if (clientes.length === 0) return 0;
  const novas = clientes.flatMap((c) => {
    const ph = phoneHash(tenant.cpfSalt, c.telefone);
    const docHash = c.cpfHash.startsWith("anon-") ? null : c.cpfHash;
    return [
      ...(c.optOutAt ? [{ tenantId, phoneHash: ph, docHash, motivo: "OPT_OUT", canal: "MANUAL", origem: "limpar_base" }] : []),
      ...(c.bloqueadoLgpdAt ? [{ tenantId, phoneHash: ph, docHash, motivo: "BLOQUEIO", canal: "MANUAL", origem: "limpar_base" }] : []),
    ];
  });
  const chave = (s: { phoneHash: string | null; docHash: string | null; motivo: string }) => `${s.motivo}|${s.phoneHash}|${s.docHash}`;
  const existentes = await prisma.supressaoTitular.findMany({ where: { tenantId, motivo: { in: ["OPT_OUT", "BLOQUEIO"] } }, select: { phoneHash: true, docHash: true, motivo: true } });
  const ja = new Set(existentes.map(chave));
  const faltam = novas.filter((n) => !ja.has(chave(n)) && (n.phoneHash || n.docHash));
  if (faltam.length) await prisma.supressaoTitular.createMany({ data: faltam });
  return faltam.length;
}

router.post("/purge", requireRole("ADMIN"), async (req, res) => {
  const { tenantId, id: userId } = req.user!;
  if (req.body?.confirm !== PURGE_CONFIRMATION) {
    return res.status(400).json({ error: `Confirmação inválida. Digite exatamente: ${PURGE_CONFIRMATION}` });
  }

  const doTenant = { client: { tenantId } };
  const [ids, movements, messageEvents, compras, historicoConta, conversas] = await Promise.all([
    prisma.client.findMany({ where: { tenantId }, select: { id: true } }),
    prisma.movement.count({ where: doTenant }),
    prisma.messageEvent.count({ where: doTenant }),
    prisma.purchase.count({ where: { tenantId } }),
    prisma.accountSnapshot.count({ where: { tenantId } }),
    prisma.conversation.count({ where: { tenantId, clientId: { not: null } } }),
  ]);
  const supressoesGravadas = await preservarSupressoes(tenantId);
  await tenantRaw.execute(PURGE_SQL);
  // Segmentos dinâmicos passam a refletir a base vazia até a próxima recontagem.
  await prisma.segmentDefinition.updateMany({ where: { tenantId }, data: { lastCount: 0, lastRefreshedAt: new Date() } });

  const clientIds = ids.map((c) => c.id);
  let auditoriaRedigida = 0;
  for (let i = 0; i < clientIds.length; i += 1000) {
    auditoriaRedigida += await redigirAuditoria(prisma, tenantId, clientIds.slice(i, i + 1000), "LIMPAR_BASE");
  }

  const resumo = { clients: clientIds.length, movements, messageEvents, compras, historicoConta, conversas, supressoesGravadas, auditoriaRedigida };
  await logAudit({ tenantId, userId, action: "PURGE_CLIENTS", target: "Client", details: resumo });
  res.json(resumo);
});

export default router;

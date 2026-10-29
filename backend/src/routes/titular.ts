import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../middleware/audit";
import { maskPhone, normalizePhone } from "../services/masking";
import { CANAIS_PEDIDO, STATUS_PEDIDO, TIPOS_PEDIDO, pedidoVencido, prazoDoPedido, relatorioContato } from "../services/titular";
import { anonymizeContato } from "../services/retention";
import { registrarOptOutTelefone } from "../services/privacy";

/**
 * LGPD 03-05: registro dos pedidos de titular (art. 18) com o prazo de 15 dias do art. 19, II. Montado em
 * /api/titular/pedidos. ADMIN e OPERATOR registram e consultam; só ADMIN fecha (atendido ou negado, com a
 * resposta dada). Não há exclusão: o registro é a prova do prazo. Tudo filtrado por tenant e auditado, sem
 * texto livre no AuditLog (descrição e resposta podem conter dado pessoal).
 */
const router = Router();
router.use(requireAuth);

const listQuery = z.object({ status: z.enum(STATUS_PEDIDO).optional() });

/** GET /api/titular/pedidos — abertos primeiro, pelo prazo; cada um marca se está vencido. */
router.get("/", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const q = listQuery.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: "Filtro de status inválido" });
  const { tenantId, id: userId } = req.user!;

  const pedidos = await prisma.pedidoTitular.findMany({
    where: { tenantId, ...(q.data.status ? { status: q.data.status } : {}) },
    orderBy: [{ status: "asc" }, { prazoEm: "asc" }],
    take: 500,
  });
  const clientIds = [...new Set(pedidos.map((p) => p.clientId).filter((x): x is string => !!x))];
  const clientes = clientIds.length
    ? await prisma.client.findMany({ where: { tenantId, id: { in: clientIds } }, select: { id: true, nome: true } })
    : [];
  const nomes = new Map(clientes.map((c) => [c.id, c.nome]));

  const agora = new Date();
  const itens = pedidos
    .map((p) => ({
      ...p,
      clienteNome: p.clientId ? nomes.get(p.clientId) ?? null : null,
      vencido: pedidoVencido(p, agora),
      diasRestantes: p.status === "ABERTO" ? Math.ceil((p.prazoEm.getTime() - agora.getTime()) / 86_400_000) : null,
    }))
    // vencidos no topo, depois os abertos pelo prazo, depois os fechados
    .sort((a, b) => Number(b.vencido) - Number(a.vencido) || Number(b.status === "ABERTO") - Number(a.status === "ABERTO") || a.prazoEm.getTime() - b.prazoEm.getTime());

  await logAudit({ tenantId, userId, action: "LIST_PEDIDOS_TITULAR", target: "PedidoTitular", details: { status: q.data.status ?? null, quantidade: itens.length } });
  res.json({ itens, vencidos: itens.filter((p) => p.vencido).length });
});

const createSchema = z.object({
  clientId: z.string().uuid().optional(),
  telefone: z.string().max(30).optional(), // só para quem não está na base: guardado mascarado
  tipo: z.enum(TIPOS_PEDIDO),
  canal: z.enum(CANAIS_PEDIDO),
  descricao: z.string().max(2000).optional(),
  recebidoEm: z.string().datetime().optional(),
});

/** POST /api/titular/pedidos — registra o pedido; prazoEm = recebidoEm + 15 dias. */
router.post("/", requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, id: userId } = req.user!;
  const b = parsed.data;

  const recebidoEm = b.recebidoEm ? new Date(b.recebidoEm) : new Date();
  if (recebidoEm.getTime() > Date.now() + 60_000) return res.status(400).json({ error: "A data de recebimento não pode estar no futuro" });

  let telefoneMasked: string | null = null;
  if (b.clientId) {
    const client = await prisma.client.findFirst({ where: { id: b.clientId, tenantId }, select: { id: true, telefone: true } });
    if (!client) return res.status(404).json({ error: "Cliente não encontrado" });
    telefoneMasked = maskPhone(client.telefone);
  } else if (b.telefone) {
    const e164 = normalizePhone(b.telefone);
    if (!e164) return res.status(400).json({ error: "Telefone inválido" });
    telefoneMasked = maskPhone(e164);
  }

  const pedido = await prisma.pedidoTitular.create({
    data: {
      tenantId,
      clientId: b.clientId ?? null,
      telefoneMasked,
      tipo: b.tipo,
      canal: b.canal,
      descricao: b.descricao?.trim() || null,
      recebidoEm,
      prazoEm: prazoDoPedido(recebidoEm),
      userId,
    },
  });
  await logAudit({
    tenantId,
    userId,
    action: "CREATE_PEDIDO_TITULAR",
    target: "PedidoTitular",
    targetId: pedido.id,
    details: { tipo: pedido.tipo, canal: pedido.canal, clientId: pedido.clientId, prazoEm: pedido.prazoEm.toISOString() },
  });
  res.status(201).json(pedido);
});

const fecharSchema = z.object({
  status: z.enum(["ATENDIDO", "NEGADO"]),
  resposta: z.string().trim().min(3).max(4000),
  // LGPD 02-09: telefone de quem pediu para parar e não está na base (contato de lista, Inbox); só para o hash
  telefone: z.string().max(30).optional(),
});

/** Pedidos que, atendidos, são um "pare de me mandar mensagem": o fechamento aplica o opt-out pelo telefone. */
const PEDIDOS_OPT_OUT = new Set(["REVOGACAO", "OPOSICAO"]);

/** POST /api/titular/pedidos/:id/fechar (ADMIN) — registra a resposta dada ao titular e a data. */
router.post("/:id/fechar", requireRole("ADMIN"), async (req, res) => {
  const parsed = fecharSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Informe o resultado (atendido ou negado) e a resposta dada ao titular" });
  const { tenantId, id: userId } = req.user!;

  const pedido = await prisma.pedidoTitular.findFirst({ where: { id: req.params.id, tenantId } });
  if (!pedido) return res.status(404).json({ error: "Pedido não encontrado" });
  if (pedido.status !== "ABERTO") return res.status(409).json({ error: "Este pedido já foi fechado" });

  // LGPD 03-09: eliminação "atendida" só depois de eliminar de fato (ficha do cliente ou "Eliminar contato")
  if (parsed.data.status === "ATENDIDO" && pedido.tipo === "ELIMINACAO") {
    const client = pedido.clientId ? await prisma.client.findFirst({ where: { id: pedido.clientId, tenantId }, select: { anonymizedAt: true } }) : null;
    if (!pedido.clientId) {
      return res.status(409).json({ error: "Para atender a eliminação de quem não é cliente, use \"Eliminar contato\" com o telefone.", code: "USE_ELIMINAR_CONTATO" });
    }
    if (client && !client.anonymizedAt) {
      return res.status(409).json({ error: "Elimine os dados na ficha do cliente; o pedido fica atendido ao final.", code: "USE_ELIMINACAO_FICHA" });
    }
  }

  // LGPD 02-09 (art. 8º, §5º / art. 18, §2º): atender revogação ou oposição É parar de enviar. O opt-out vale pelo
  // telefone (supressão + todos os cadastros e listas com o número), antes de o pedido constar como atendido.
  let optOut: { clientes: number } | null = null;
  if (parsed.data.status === "ATENDIDO" && PEDIDOS_OPT_OUT.has(pedido.tipo)) {
    const client = pedido.clientId ? await prisma.client.findFirst({ where: { id: pedido.clientId, tenantId }, select: { telefone: true } }) : null;
    const telefone = client?.telefone ?? (parsed.data.telefone ? normalizePhone(parsed.data.telefone) : null);
    if (!telefone) {
      return res.status(400).json({ error: "Informe o telefone de quem pediu para parar: o descadastro vale pelo número.", code: "TELEFONE_OBRIGATORIO" });
    }
    const r = await registrarOptOutTelefone(prisma, tenantId, { telefone, canal: pedido.canal, origem: "pedido_titular" });
    optOut = { clientes: r.clientIds.length };
  }

  const respondidoEm = new Date();
  const atualizado = await prisma.pedidoTitular.update({
    where: { id: pedido.id },
    data: { status: parsed.data.status, resposta: parsed.data.resposta, respondidoEm },
  });
  await logAudit({
    tenantId,
    userId,
    action: "CLOSE_PEDIDO_TITULAR",
    target: "PedidoTitular",
    targetId: pedido.id,
    details: { status: parsed.data.status, tipo: pedido.tipo, noPrazo: respondidoEm.getTime() <= pedido.prazoEm.getTime(), ...(optOut ? { optOut } : {}) },
  });
  res.json(atualizado);
});

/**
 * LGPD 03-09: pedido de quem NÃO é cliente da base (contato de lista manual, quem só escreveu no WhatsApp). O telefone
 * vem no corpo (nunca na URL), serve só para achar os registros e não é gravado nem logado.
 */
const contatoSchema = z.object({ telefone: z.string().min(8).max(30) });
export const CONFIRMA_ELIMINACAO_CONTATO = "ELIMINAR DADOS";
const eliminarContatoSchema = contatoSchema.extend({ confirmacao: z.literal(CONFIRMA_ELIMINACAO_CONTATO) });

async function pedidoSemCliente(tenantId: string, id: string) {
  const pedido = await prisma.pedidoTitular.findFirst({ where: { id, tenantId } });
  if (!pedido) return { erro: [404, "Pedido não encontrado"] as const };
  if (pedido.clientId) return { erro: [409, "Pedido de cliente da base: use o relatório e a eliminação da ficha do cliente."] as const };
  return { pedido };
}

/** POST /api/titular/pedidos/:id/relatorio-contato (ADMIN) — tudo o que o sistema guarda do número (acesso, art. 18 II). */
router.post("/:id/relatorio-contato", requireRole("ADMIN"), async (req, res) => {
  const parsed = contatoSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Informe o telefone do titular" });
  const { tenantId, id: userId } = req.user!;
  const p = await pedidoSemCliente(tenantId, req.params.id);
  if (p.erro) return res.status(p.erro[0]).json({ error: p.erro[1] });
  const rel = await relatorioContato(prisma, tenantId, parsed.data.telefone);
  if (!rel) return res.status(400).json({ error: "Telefone inválido" });
  await logAudit({
    tenantId,
    userId,
    action: "RELATORIO_CONTATO",
    target: "PedidoTitular",
    targetId: p.pedido.id,
    details: { listas: rel.listasManuais.length, mensagens: rel.mensagens.length, conversas: rel.conversas.length },
  });
  res.json(rel);
});

/**
 * POST /api/titular/pedidos/:id/eliminar-contato (ADMIN) — elimina o contato pelo telefone (services/retention.ts,
 * anonymizeContato) e fecha o pedido de eliminação como atendido. Se o número é de um cliente da base, 409 com o id
 * para a eliminação ser feita na ficha.
 */
router.post("/:id/eliminar-contato", requireRole("ADMIN"), async (req, res) => {
  const parsed = eliminarContatoSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: `Informe o telefone e confirme digitando: ${CONFIRMA_ELIMINACAO_CONTATO}` });
  const { tenantId, id: userId } = req.user!;
  const p = await pedidoSemCliente(tenantId, req.params.id);
  if (p.erro) return res.status(p.erro[0]).json({ error: p.erro[1] });
  if (p.pedido.tipo !== "ELIMINACAO" || p.pedido.status !== "ABERTO") {
    return res.status(409).json({ error: "Só um pedido de eliminação aberto pode ser atendido assim" });
  }
  const r = await anonymizeContato(prisma, tenantId, parsed.data.telefone, { motivo: `pedido do titular ${p.pedido.id}`, pedidoId: p.pedido.id, userId });
  if (!r) return res.status(400).json({ error: "Telefone inválido" });
  if ("clienteDaBase" in r) {
    return res.status(409).json({ error: "Este número é de um cliente da base: elimine os dados na ficha dele.", code: "CONTATO_E_CLIENTE", clientId: r.clienteDaBase });
  }
  // o texto livre e o telefone mascarado do pedido também saem; tipo, datas e status ficam como prova
  await prisma.pedidoTitular.update({
    where: { id: p.pedido.id },
    data: { status: "ATENDIDO", respondidoEm: new Date(), resposta: "Dados do contato eliminados (anonimização) no CRM.", descricao: null, telefoneMasked: null },
  });
  res.json(r);
});

export default router;


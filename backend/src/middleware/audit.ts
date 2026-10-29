import { prisma } from "../config/db";
import { computeAuditHash, ehConflitoDeElo, genesisHash, nextCreatedAt, prepareTenantChain } from "../services/auditIntegrity";

type AuditParams = {
  tenantId: string;
  userId?: string;
  action: string;
  target?: string;
  targetId?: string;
  details?: unknown;
};

/**
 * LGPD 05-08: quantas vezes reler o topo da cadeia quando outra gravação do mesmo tenant se prendeu ao mesmo elo
 * (UNIQUE(tenantId, prevHash), ver services/auditIntegrity.ts). Cada conflito significa que alguém avançou a
 * cadeia, então esgotar as tentativas só acontece com muitas gravações simultâneas do mesmo tenant.
 */
const MAX_TENTATIVAS = 8;

const pausa = () => new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 20)));

/** Registra uma ação no log de auditoria (LGPD/compliance): quem, o quê, quando, em qual registro. */
export async function logAudit(params: AuditParams): Promise<void> {
  for (let tentativa = 1; ; tentativa++) {
    try {
      return await gravarAudit(params);
    } catch (e) {
      if (!ehConflitoDeElo(e) || tentativa >= MAX_TENTATIVAS) throw e;
      await pausa();
    }
  }
}

async function gravarAudit(params: AuditParams) {
  // LGPD 08-08: encadeia com a última entrada DO MESMO tenant (grava a âncora da cadeia por
  // tenant na primeira vez). Ver services/auditIntegrity.ts.
  const tip = await prepareTenantChain(params.tenantId);
  const prevHash = tip.hash ?? genesisHash(params.tenantId);
  // Cadeia de hash (achado #11, tamper-evidence): createdAt é gerado aqui em vez de deixar o
  // @default(now()) do schema preencher, para que o valor usado no hash seja exatamente o valor
  // persistido (e sempre posterior ao elo anterior, para a ordenação seguir a cadeia).
  const createdAt = nextCreatedAt(tip.createdAt);
  const entry = {
    tenantId: params.tenantId,
    userId: params.userId ?? null,
    action: params.action,
    target: params.target ?? null,
    targetId: params.targetId ?? null,
    details: params.details ?? null,
    createdAt,
  };
  const hash = computeAuditHash(entry, prevHash);

  await prisma.auditLog.create({
    data: { ...entry, details: entry.details as any, prevHash, hash },
  });
}

/**
 * LGPD 05-03: ações de tentativa de acesso indevido. Ficam no AuditLog com ação própria para o
 * controlador conseguir responder "desde quando houve tentativas e se tiveram sucesso"
 * (filtro `grupo=acesso_indevido` em GET /api/audit-logs).
 */
export const ACOES_ACESSO_INDEVIDO = {
  LOGIN_FALHA: "LOGIN_FALHA",
  LOGIN_BLOQUEADO: "LOGIN_BLOQUEADO",
  FALHA_2FA: "2FA_FALHA",
  ACESSO_NEGADO: "ACESSO_NEGADO",
  IMPORTACAO_PLANILHA_NEGADA: "IMPORT_GOOGLE_SHEETS_NEGADO",
} as const;

type ReqComCabecalhos = { headers: Record<string, string | string[] | undefined>; ip?: string };

function cabecalho(req: ReqComCabecalhos, nome: string): string | undefined {
  const v = req.headers[nome];
  return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
}

/**
 * IP de quem chamou. Na Cloudflare vale só o `CF-Connecting-IP`, que a própria plataforma preenche
 * (X-Forwarded-For e afins o cliente pode forjar); fora dela (testes, Node) cai no req.ip.
 */
export function ipDoCliente(req: ReqComCabecalhos): string | undefined {
  return (cabecalho(req, "cf-connecting-ip") || req.ip || "").slice(0, 64) || undefined;
}

/**
 * LGPD 05-03: "de onde veio" a tentativa, guardado nos detalhes (o AuditLog não tem colunas ip/
 * userAgent; acrescentá-las é pendência de schema). User-Agent truncado.
 */
export function origemRequisicao(req: ReqComCabecalhos) {
  return { ip: ipDoCliente(req) ?? null, userAgent: cabecalho(req, "user-agent")?.slice(0, 200) ?? null };
}

/**
 * LGPD 05-03: grava uma tentativa de acesso indevido sem nunca derrubar a resposta de quem
 * chamou (um 401 não pode virar 500 porque a auditoria falhou). Os detalhes são montados pelo
 * chamador e nunca levam senha, token ou código 2FA; e-mail só mascarado.
 */
export async function logTentativaAcesso(params: {
  tenantId: string;
  userId?: string;
  action: (typeof ACOES_ACESSO_INDEVIDO)[keyof typeof ACOES_ACESSO_INDEVIDO];
  details: Record<string, unknown>;
}) {
  try {
    await logAudit({ ...params, target: "User", targetId: params.userId });
  } catch (e) {
    console.error("[audit] falha ao registrar tentativa de acesso:", params.action, e);
  }
}

/**
 * LGPD 05-03: 403 por papel. Para ser ligado em requireRole (middleware/auth.ts, fora deste lote):
 * `void logAcessoNegado(req.user, req.method, req.originalUrl, roles)` antes do `res.status(403)`.
 * Não grava query string (pode ter filtros com dado pessoal).
 */
export async function logAcessoNegado(
  user: { id: string; tenantId: string; role: string } | undefined,
  method: string,
  url: string,
  papeisExigidos: string[]
) {
  if (!user) return;
  await logTentativaAcesso({
    tenantId: user.tenantId,
    userId: user.id,
    action: ACOES_ACESSO_INDEVIDO.ACESSO_NEGADO,
    details: { metodo: method, rota: url.split("?")[0], papel: user.role, papeisExigidos },
  });
}

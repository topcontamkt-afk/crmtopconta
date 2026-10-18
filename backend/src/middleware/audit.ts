import { prisma } from "../config/db";
import { computeAuditHash, nextCreatedAt, prepareTenantChain } from "../services/auditIntegrity";

/** Registra uma ação no log de auditoria (LGPD/compliance): quem, o quê, quando, em qual registro. */
export async function logAudit(params: {
  tenantId: string;
  userId?: string;
  action: string;
  target?: string;
  targetId?: string;
  details?: unknown;
}) {
  // LGPD 08-08: encadeia com a última entrada DO MESMO tenant (grava a âncora da cadeia por
  // tenant na primeira vez). Ver services/auditIntegrity.ts.
  const tip = await prepareTenantChain(params.tenantId);
  const prevHash = tip.hash;
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

/**
 * LGPD 05-03: "de onde veio" a tentativa, guardado nos detalhes (o AuditLog não tem colunas ip/
 * userAgent; acrescentá-las é pendência de schema). Na Vercel o IP do cliente vem do cabeçalho
 * que a própria plataforma preenche; fora dela cai no req.ip. User-Agent truncado.
 */
export function origemRequisicao(req: { headers: Record<string, string | string[] | undefined>; ip?: string }) {
  const h = (nome: string) => {
    const v = req.headers[nome];
    return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  };
  const ip = (h("x-vercel-forwarded-for") || h("x-real-ip") || h("x-forwarded-for")?.split(",")[0] || req.ip || "").trim();
  return { ip: ip.slice(0, 64) || null, userAgent: h("user-agent")?.slice(0, 200) ?? null };
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

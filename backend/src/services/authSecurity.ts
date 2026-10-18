import { User } from "@prisma/client";
import { AppPrismaClient } from "../config/db";

/**
 * Rate limiting anti brute-force para login — armazenado no banco (não em memória do processo),
 * para funcionar de forma consistente entre invocações serverless distintas (cada requisição pode
 * cair numa instância de função diferente; um contador em memória não resistiria a isso).
 */
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;

export function isLocked(user: Pick<User, "lockedUntil">): boolean {
  return !!user.lockedUntil && user.lockedUntil.getTime() > Date.now();
}

export function lockedMinutesRemaining(user: Pick<User, "lockedUntil">): number {
  if (!user.lockedUntil) return 0;
  return Math.max(0, Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000));
}

export type FailedLoginResult = { count: number; locked: boolean; lockedUntil: Date | null };

/**
 * Chamado após uma senha incorreta: incrementa o contador e bloqueia a conta se atingir o limite.
 * LGPD 05-03: devolve o resultado para a rota registrar a tentativa (e o bloqueio) no AuditLog,
 * já que o contador em User é sobrescrito e zerado no próximo login certo.
 */
export async function registerFailedLogin(
  prisma: AppPrismaClient,
  userId: string,
  currentCount: number
): Promise<FailedLoginResult> {
  const count = currentCount + 1;
  const data: { failedLoginCount: number; lockedUntil?: Date } = { failedLoginCount: count };
  if (count >= MAX_FAILED_ATTEMPTS) {
    data.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
  }
  await prisma.user.update({ where: { id: userId }, data });
  return { count, locked: !!data.lockedUntil, lockedUntil: data.lockedUntil ?? null };
}

/** Chamado após um login bem-sucedido: zera o contador e qualquer bloqueio ativo. */
export async function resetFailedLogins(prisma: AppPrismaClient, userId: string) {
  await prisma.user.update({ where: { id: userId }, data: { failedLoginCount: 0, lockedUntil: null } });
}

/**
 * LGPD 05-03: e-mail mascarado para os detalhes de tentativas de acesso (AuditLog e log do
 * servidor). Mantém o domínio e as 2 primeiras letras, o suficiente para reconhecer a conta
 * visada sem gravar o endereço inteiro. Ex.: "joao.silva@empresa.com" -> "jo***@empresa.com".
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  return `${local.slice(0, Math.min(2, local.length - 1))}***@${domain}`;
}

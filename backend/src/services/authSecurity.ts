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

/** Chamado após uma senha incorreta: incrementa o contador e bloqueia a conta se atingir o limite. */
export async function registerFailedLogin(prisma: AppPrismaClient, userId: string, currentCount: number) {
  const count = currentCount + 1;
  const data: { failedLoginCount: number; lockedUntil?: Date } = { failedLoginCount: count };
  if (count >= MAX_FAILED_ATTEMPTS) {
    data.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
  }
  await prisma.user.update({ where: { id: userId }, data });
}

/** Chamado após um login bem-sucedido: zera o contador e qualquer bloqueio ativo. */
export async function resetFailedLogins(prisma: AppPrismaClient, userId: string) {
  await prisma.user.update({ where: { id: userId }, data: { failedLoginCount: 0, lockedUntil: null } });
}

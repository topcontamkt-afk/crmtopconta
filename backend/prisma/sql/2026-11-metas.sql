-- Financeiro e metas (fase 5): metas mensais de lucro e de usos, na própria tabela Tenant.
-- Rodar ANTES do deploy (o Prisma passa a conhecer a coluna; sem ela, a tela Financeiro mostra "metas indisponíveis").
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "metas" JSONB;

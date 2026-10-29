-- Acesso por área do sistema (Usuários → Acessos). Rodar no SQL Editor do Supabase ANTES de publicar o
-- backend novo. Só colunas novas em "User" (sem tabela nova: RLS/GRANT não mudam). Quem já existe fica
-- SEM restrição (areasRestritas=false = vê todas as áreas), então ninguém perde acesso ao publicar.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "areasRestritas" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "areas" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

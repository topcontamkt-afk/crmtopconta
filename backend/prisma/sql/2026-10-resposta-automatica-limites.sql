-- Resposta automática da Inbox: máximo por conversa e janela em horas, configuráveis por conta.
-- Rodar no SQL Editor do Supabase ANTES de publicar o backend novo. Só colunas novas (RLS/GRANT não mudam).
ALTER TABLE "WhatsAppAccount" ADD COLUMN IF NOT EXISTS "autoReplyMax" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "WhatsAppAccount" ADD COLUMN IF NOT EXISTS "autoReplyJanelaHoras" INTEGER NOT NULL DEFAULT 24;

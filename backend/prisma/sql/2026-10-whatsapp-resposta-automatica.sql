-- Inbox do WhatsApp: resposta automática (canal só de avisos → manda o cliente ao suporte).
-- Rodar no SQL Editor do Supabase ANTES de publicar o backend novo. Só colunas novas (sem tabela nova,
-- então RLS/GRANT não mudam). A resposta já nasce LIGADA para a conta existente; texto nulo = padrão.
ALTER TABLE "WhatsAppAccount" ADD COLUMN IF NOT EXISTS "autoReplyEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "WhatsAppAccount" ADD COLUMN IF NOT EXISTS "autoReplyText" TEXT;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "lastAutoReplyAt" TIMESTAMP(3);
ALTER TABLE "WaMessage" ADD COLUMN IF NOT EXISTS "automatic" BOOLEAN NOT NULL DEFAULT false;

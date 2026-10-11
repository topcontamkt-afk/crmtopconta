-- Inbox do WhatsApp, Fase 3: guarda quem enviou cada resposta. Rodar no SQL Editor do Supabase
-- ANTES de publicar o backend novo. Coluna anulável: mensagens antigas ficam sem remetente.
ALTER TABLE "WaMessage" ADD COLUMN IF NOT EXISTS "sentByUserId" TEXT;

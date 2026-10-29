-- Conexão Z-API (WhatsApp não oficial) ao lado da Meta. Rodar no SQL Editor do Supabase ANTES de publicar o
-- backend novo. Só colunas novas com padrão META: tudo que já existe continua sendo Meta, sem mudança de comportamento.
ALTER TABLE "WhatsAppAccount" ADD COLUMN IF NOT EXISTS "provider" TEXT NOT NULL DEFAULT 'META';
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "whatsappProvider" TEXT NOT NULL DEFAULT 'META';

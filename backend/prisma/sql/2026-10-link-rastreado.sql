-- Link rastreado nos botões de template (fase 2): clique registrado por mensagem.
-- Rodar no SQL Editor do Supabase ANTES de publicar o backend novo. Só adiciona colunas.
ALTER TABLE "MessageEvent" ADD COLUMN IF NOT EXISTS "clickedAt" TIMESTAMP(3);
ALTER TABLE "MessageEvent" ADD COLUMN IF NOT EXISTS "clickCount" INTEGER NOT NULL DEFAULT 0;

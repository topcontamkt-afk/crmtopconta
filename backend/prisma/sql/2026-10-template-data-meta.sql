-- Templates: data informada pela Meta (last_updated_time), para ordenar a lista. Rodar no SQL Editor do Supabase
-- ANTES de publicar o backend novo. Só coluna nova (RLS/GRANT não mudam).
ALTER TABLE "MessageTemplate" ADD COLUMN IF NOT EXISTS "metaUpdatedAt" TIMESTAMP(3);

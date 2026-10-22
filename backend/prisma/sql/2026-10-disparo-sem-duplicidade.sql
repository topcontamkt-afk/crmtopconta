-- Disparo sem duplicidade: trava por campanha e reserva dos itens da fila. Rodar no SQL Editor do Supabase ANTES de
-- publicar o backend novo. Só colunas novas (RLS/GRANT não mudam).
ALTER TABLE "MessageEvent" ADD COLUMN IF NOT EXISTS "claimToken" TEXT;
ALTER TABLE "MessageEvent" ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3);
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "dispatchToken" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "dispatchUntil" TIMESTAMP(3);

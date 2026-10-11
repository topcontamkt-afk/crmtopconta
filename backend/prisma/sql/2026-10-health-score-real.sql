-- Nota de saúde por uso real gravada no snapshot diário (services/healthData.ts). Rodar no SQL
-- Editor do Supabase ANTES de publicar o backend novo. Coluna anulável: dias antigos ficam null.
ALTER TABLE "DashboardSnapshot" ADD COLUMN IF NOT EXISTS "healthScore" INTEGER;

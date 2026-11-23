-- Insights (fase 1): guarda a contagem diária de cada oportunidade no snapshot do dashboard,
-- para a fila de oportunidades mostrar tendência. O histórico começa no dia em que isto rodar.
-- Rodar ANTES do deploy (o upsert do snapshot passa a escrever esta coluna).
ALTER TABLE "DashboardSnapshot" ADD COLUMN IF NOT EXISTS "oportunidades" JSONB;

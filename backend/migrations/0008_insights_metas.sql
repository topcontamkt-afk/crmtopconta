-- Insights (fases 1 e 5): contagem diária das oportunidades no snapshot do dashboard e metas mensais do tenant.
-- Colunas novas, nulas: o código antigo as ignora, então esta migration pode rodar antes do deploy.
ALTER TABLE "DashboardSnapshot" ADD COLUMN "oportunidades" JSONB;
ALTER TABLE "Tenant" ADD COLUMN "metas" JSONB;

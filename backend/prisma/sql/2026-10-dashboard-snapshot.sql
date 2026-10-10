-- DashboardSnapshot: histórico diário dos KPIs do dashboard (tendência e variação entre períodos).
-- Aditivo (só cria tabela nova). Aplicar no Supabase como as demais mudanças de schema
-- (ver "Deployment topology" no CLAUDE.md). Mesmo padrão de RLS das outras tabelas com tenantId.

CREATE TABLE IF NOT EXISTS "DashboardSnapshot" (
  "id"              TEXT NOT NULL,
  "tenantId"        TEXT NOT NULL,
  "day"             DATE NOT NULL,
  "totalClientes"   INTEGER NOT NULL,
  "ativos"          INTEGER NOT NULL,
  "inativos"        INTEGER NOT NULL,
  "bloqueados"      INTEGER NOT NULL,
  "semUso"          INTEGER NOT NULL,
  "limiteTotal"     DECIMAL(16,2) NOT NULL,
  "valorUtilizado"  DECIMAL(16,2) NOT NULL,
  "saldoDisponivel" DECIMAL(16,2) NOT NULL,
  "usaramNoDia"     INTEGER NOT NULL DEFAULT 0,
  "encerradosNoDia" INTEGER NOT NULL DEFAULT 0,
  "faixas"          JSONB NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DashboardSnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DashboardSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "DashboardSnapshot_tenantId_day_key" ON "DashboardSnapshot"("tenantId", "day");
CREATE INDEX IF NOT EXISTS "DashboardSnapshot_tenantId_day_idx" ON "DashboardSnapshot"("tenantId", "day");

ALTER TABLE "DashboardSnapshot" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "DashboardSnapshot";
CREATE POLICY tenant_isolation ON "DashboardSnapshot"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "DashboardSnapshot" TO app_runtime;

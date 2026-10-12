-- Proteção da importação: formato/lote/arquivo no histórico, desfazer lote (estado anterior dos clientes).
-- Rodar no SQL Editor do Supabase ANTES de publicar o backend novo. Só adiciona colunas e uma tabela.

ALTER TABLE "ImportJob" ADD COLUMN IF NOT EXISTS "formato" TEXT;
ALTER TABLE "ImportJob" ADD COLUMN IF NOT EXISTS "loteId" TEXT;
ALTER TABLE "ImportJob" ADD COLUMN IF NOT EXISTS "nomeArquivo" TEXT;
ALTER TABLE "ImportJob" ADD COLUMN IF NOT EXISTS "desfeitaEm" TIMESTAMP(3);
ALTER TABLE "ImportJob" ADD COLUMN IF NOT EXISTS "desfeitaPor" TEXT;
CREATE INDEX IF NOT EXISTS "ImportJob_tenantId_loteId_idx" ON "ImportJob"("tenantId", "loteId");

CREATE TABLE IF NOT EXISTS "ImportChange" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "importJobId" TEXT NOT NULL,
    "loteId" TEXT,
    "clientId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "before" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportChange_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ImportChange_tenantId_loteId_idx" ON "ImportChange"("tenantId", "loteId");
CREATE INDEX IF NOT EXISTS "ImportChange_importJobId_idx" ON "ImportChange"("importJobId");

ALTER TABLE "ImportChange" ADD CONSTRAINT "ImportChange_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ImportChange" ADD CONSTRAINT "ImportChange_importJobId_fkey" FOREIGN KEY ("importJobId") REFERENCES "ImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ImportChange" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "ImportChange"
  FOR ALL
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "ImportChange" TO app_runtime;

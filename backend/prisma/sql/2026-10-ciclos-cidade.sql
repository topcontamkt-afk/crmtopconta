-- Ciclo de cobrança por cidade (abertura = renovação do limite) e dia de abertura guardado no cliente.
-- Rodar no SQL Editor do Supabase ANTES de publicar o backend novo. Só adiciona uma tabela e uma coluna.

ALTER TABLE "Client" ADD COLUMN IF NOT EXISTS "diaCicloAbertura" INTEGER;
CREATE INDEX IF NOT EXISTS "Client_tenantId_diaCicloAbertura_idx" ON "Client"("tenantId", "diaCicloAbertura");

CREATE TABLE IF NOT EXISTS "CicloCidade" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cidadeKey" TEXT NOT NULL,
    "cidade" TEXT NOT NULL,
    "diaAbertura" INTEGER NOT NULL,
    "diaFechamento" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CicloCidade_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CicloCidade_tenantId_cidadeKey_key" ON "CicloCidade"("tenantId", "cidadeKey");

ALTER TABLE "CicloCidade" ADD CONSTRAINT "CicloCidade_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CicloCidade" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "CicloCidade"
  FOR ALL
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "CicloCidade" TO app_runtime;

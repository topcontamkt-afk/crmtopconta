-- Merchant + Purchase: comércio credenciado e transações do cartão (aba "Todas as Compras").
-- Aditivo (só cria tabelas novas). Mesmo padrão de RLS das demais tabelas com tenantId.

CREATE TABLE IF NOT EXISTS "Merchant" (
  "id"             TEXT NOT NULL,
  "tenantId"       TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "nameKey"        TEXT NOT NULL,
  "category"       TEXT NOT NULL DEFAULT 'OUTROS',
  "categorySource" TEXT NOT NULL DEFAULT 'AUTO',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Merchant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Merchant_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "Merchant_tenantId_nameKey_key" ON "Merchant"("tenantId", "nameKey");
CREATE INDEX IF NOT EXISTS "Merchant_tenantId_category_idx" ON "Merchant"("tenantId", "category");

CREATE TABLE IF NOT EXISTS "Purchase" (
  "id"             TEXT NOT NULL,
  "tenantId"       TEXT NOT NULL,
  "clientId"       TEXT NOT NULL,
  "merchantId"     TEXT,
  "externalId"     TEXT NOT NULL,
  "occurredAt"     TIMESTAMP(3) NOT NULL,
  "tipo"           TEXT NOT NULL,
  "merchantName"   TEXT,
  "valorPrincipal" DECIMAL(14,2) NOT NULL,
  "valorParcela"   DECIMAL(14,2),
  "juros"          DECIMAL(14,2),
  "razaoSocial"    TEXT,
  "importJobId"    TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Purchase_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Purchase_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Purchase_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Purchase_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "Purchase_tenantId_externalId_key" ON "Purchase"("tenantId", "externalId");
CREATE INDEX IF NOT EXISTS "Purchase_tenantId_occurredAt_idx" ON "Purchase"("tenantId", "occurredAt");
CREATE INDEX IF NOT EXISTS "Purchase_clientId_occurredAt_idx" ON "Purchase"("clientId", "occurredAt");
CREATE INDEX IF NOT EXISTS "Purchase_merchantId_occurredAt_idx" ON "Purchase"("merchantId", "occurredAt");

ALTER TABLE "Merchant" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Merchant"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
ALTER TABLE "Purchase" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Purchase"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "Merchant" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Purchase" TO app_runtime;

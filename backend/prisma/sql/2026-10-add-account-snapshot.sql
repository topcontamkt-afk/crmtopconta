-- Histórico de saldo/limite/status da conta (services/accountSnapshot.ts, gravado pela
-- importação de "Cartões e contas"). Rodar no SQL Editor do Supabase, ANTES de publicar o
-- backend novo (senão a gravação do histórico falha — sem derrubar a importação, mas sem
-- histórico). Gerado com `prisma migrate diff` contra o schema anterior + RLS.
-- Rodar DEPOIS de 2026-10-add-transaction.sql.

-- CreateTable
CREATE TABLE "AccountSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "limiteTotal" DECIMAL(14,2) NOT NULL,
    "saldoDisponivel" DECIMAL(14,2) NOT NULL,
    "saldoAnterior" DECIMAL(14,2),
    "valorUtilizado" DECIMAL(14,2) NOT NULL,
    "statusConta" "ClientStatus" NOT NULL,
    "importJobId" TEXT,

    CONSTRAINT "AccountSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountSnapshot_tenantId_clientId_recordedAt_idx" ON "AccountSnapshot"("tenantId", "clientId", "recordedAt");

-- CreateIndex
CREATE INDEX "AccountSnapshot_tenantId_recordedAt_idx" ON "AccountSnapshot"("tenantId", "recordedAt");

-- AddForeignKey
ALTER TABLE "AccountSnapshot" ADD CONSTRAINT "AccountSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountSnapshot" ADD CONSTRAINT "AccountSnapshot_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- RLS real — mesmo texto da policy de "Transaction" (confira contra as policies de produção:
-- SELECT policyname, qual, with_check FROM pg_policies WHERE tablename = 'Client';).
ALTER TABLE "AccountSnapshot" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "AccountSnapshot"
  FOR ALL
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- Se o role app_runtime não herda privilégios por default privileges, descomente:
-- GRANT SELECT, INSERT, UPDATE, DELETE ON "AccountSnapshot" TO app_runtime;

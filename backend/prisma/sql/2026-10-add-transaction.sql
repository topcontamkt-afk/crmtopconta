-- Extrato de transações do cartão (importação: services/transactionImport.ts).
-- Rodar no SQL Editor do Supabase (mesmo caminho das demais mudanças de schema — ver CLAUDE.md,
-- "Deployment topology"). Gerado com `prisma migrate diff` contra o schema anterior + RLS.
-- Ordem: este arquivo ANTES de publicar o backend novo, senão o importador falha ao gravar.

-- CreateEnum
CREATE TYPE "TransactionKind" AS ENUM ('ANTECIPACAO', 'COMPRA', 'ASSINATURA', 'OUTRO');

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT,
    "cpfHash" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL,
    "descricao" TEXT NOT NULL,
    "nomeFantasia" TEXT,
    "razaoSocial" TEXT,
    "kind" "TransactionKind" NOT NULL,
    "countsAsUsage" BOOLEAN NOT NULL,
    "valorTotal" DECIMAL(14,2) NOT NULL,
    "valorPrincipal" DECIMAL(14,2) NOT NULL,
    "juros" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "importJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Transaction_tenantId_clientId_confirmedAt_idx" ON "Transaction"("tenantId", "clientId", "confirmedAt");

-- CreateIndex
CREATE INDEX "Transaction_tenantId_cpfHash_idx" ON "Transaction"("tenantId", "cpfHash");

-- CreateIndex
CREATE INDEX "Transaction_tenantId_confirmedAt_idx" ON "Transaction"("tenantId", "confirmedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_tenantId_externalId_key" ON "Transaction"("tenantId", "externalId");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- RLS real (mesmo desenho das demais tabelas: ver docs/security-audit, achado #1/#6b).
-- ATENÇÃO: o texto exato das policies de produção não está no repo — antes de rodar, confira o
-- padrão com `SELECT policyname, qual, with_check FROM pg_policies WHERE tablename = 'Client';`
-- e ajuste o USING/WITH CHECK abaixo para ficar idêntico.
-- Sem a policy, o role app_runtime (NOBYPASSRLS) enxerga zero linhas e a importação falha.
ALTER TABLE "Transaction" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "Transaction"
  FOR ALL
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- Se o role app_runtime não herda privilégios por default privileges, descomente:
-- GRANT SELECT, INSERT, UPDATE, DELETE ON "Transaction" TO app_runtime;

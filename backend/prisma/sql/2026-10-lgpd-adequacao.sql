-- Adequação LGPD (docs/lgpd/correcoes/plano.md, Lote 0). Rodar no SQL Editor do Supabase ANTES de publicar o
-- backend novo. Idempotente: pode rodar de novo sem efeito. Só adiciona colunas e tabelas (nada é apagado).
--
-- ATENÇÃO à última seção: o backend novo BLOQUEIA envio de marketing de tenant sem base legal declarada
-- (Tenant.baseLegalMarketing nulo). O UPDATE no fim declara LEGITIMO_INTERESSE para os tenants que já existem,
-- conforme a triagem de 2026-10-18 (docs/lgpd/auditoria/2026-10-18/triagem.md, decisão 1), para a produção não
-- parar. Tenant criado depois nasce bloqueado até o controlador declarar a base.

-- Tenant: configuração LGPD do controlador
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "baseLegalMarketing" TEXT;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "liaVersao" TEXT;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "liaAprovadaEm" TIMESTAMP(3);
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "controladorNome" TEXT;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "encarregadoNome" TEXT;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "encarregadoContato" TEXT;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "avisoPrivacidadeUrl" TEXT;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "rodapeOptOut" TEXT;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "retentionBasis" TEXT;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "retentionDaysAfterClosure" INTEGER;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "inboxRetentionDays" INTEGER;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "mediaRetentionDays" INTEGER NOT NULL DEFAULT 90;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "correcaoManualVence" BOOLEAN NOT NULL DEFAULT true;

-- Client: suspensão a pedido e trava de correção manual
ALTER TABLE "Client" ADD COLUMN IF NOT EXISTS "bloqueadoLgpdAt" TIMESTAMP(3);
ALTER TABLE "Client" ADD COLUMN IF NOT EXISTS "camposCorrigidos" JSONB;

-- Campaign: base legal vigente e prova declarada de consentimento (lista manual)
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "baseLegal" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "consentimentoOrigem" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "consentimentoPor" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "consentimentoEm" TIMESTAMP(3);

-- Supressão por titular (só hashes)
CREATE TABLE IF NOT EXISTS "SupressaoTitular" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "phoneHash" TEXT,
    "docHash" TEXT,
    "motivo" TEXT NOT NULL,
    "canal" TEXT,
    "origem" TEXT NOT NULL,
    "pedidoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SupressaoTitular_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "SupressaoTitular_tenantId_phoneHash_idx" ON "SupressaoTitular"("tenantId", "phoneHash");
CREATE INDEX IF NOT EXISTS "SupressaoTitular_tenantId_docHash_idx" ON "SupressaoTitular"("tenantId", "docHash");

-- Pedidos de titular (art. 18/19)
CREATE TABLE IF NOT EXISTS "PedidoTitular" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT,
    "telefoneMasked" TEXT,
    "tipo" TEXT NOT NULL,
    "canal" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ABERTO',
    "descricao" TEXT,
    "recebidoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "prazoEm" TIMESTAMP(3) NOT NULL,
    "respondidoEm" TIMESTAMP(3),
    "resposta" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PedidoTitular_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "PedidoTitular_tenantId_status_idx" ON "PedidoTitular"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "PedidoTitular_tenantId_clientId_idx" ON "PedidoTitular"("tenantId", "clientId");

DO $$ BEGIN
  ALTER TABLE "SupressaoTitular" ADD CONSTRAINT "SupressaoTitular_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "PedidoTitular" ADD CONSTRAINT "PedidoTitular_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- RLS: mesma policy das demais tabelas com tenantId; sem o GRANT o role app_runtime não grava
ALTER TABLE "SupressaoTitular" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PedidoTitular" ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY tenant_isolation ON "SupressaoTitular" FOR ALL
    USING ("tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY tenant_isolation ON "PedidoTitular" FOR ALL
    USING ("tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON "SupressaoTitular" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "PedidoTitular" TO app_runtime;

-- Base legal dos tenants existentes (triagem 2026-10-18, decisão 1). LIA ainda pendente da controladora.
UPDATE "Tenant" SET "baseLegalMarketing" = 'LEGITIMO_INTERESSE' WHERE "baseLegalMarketing" IS NULL;

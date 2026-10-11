-- Assistente de campanhas (4 passos): templates importados da Meta, imagem no cabeçalho, custo estimado.
-- Rodar no SQL Editor do Supabase ANTES de publicar o backend novo (depois de 2026-10-campanha-manual.sql).
-- Só adiciona colunas e uma tabela nova.

-- MessageTemplate: cabeçalho de imagem + templates importados da Meta
ALTER TABLE "MessageTemplate" ADD COLUMN IF NOT EXISTS "headerFormat" TEXT;
ALTER TABLE "MessageTemplate" ADD COLUMN IF NOT EXISTS "headerHandle" TEXT;
ALTER TABLE "MessageTemplate" ADD COLUMN IF NOT EXISTS "origin" TEXT NOT NULL DEFAULT 'LOCAL';
ALTER TABLE "MessageTemplate" ADD COLUMN IF NOT EXISTS "metaBody" TEXT;
ALTER TABLE "MessageTemplate" ADD COLUMN IF NOT EXISTS "variableMap" JSONB;
ALTER TABLE "MessageTemplate" ADD COLUMN IF NOT EXISTS "buttons" JSONB;
ALTER TABLE "MessageTemplate" ADD COLUMN IF NOT EXISTS "sendIssue" TEXT;

-- Imagem do cabeçalho
CREATE TABLE IF NOT EXISTS "TemplateMedia" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TemplateMedia_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TemplateMedia_templateId_key" ON "TemplateMedia"("templateId");

ALTER TABLE "TemplateMedia" ADD CONSTRAINT "TemplateMedia_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TemplateMedia" ADD CONSTRAINT "TemplateMedia_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "MessageTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TemplateMedia" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "TemplateMedia"
  FOR ALL
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "TemplateMedia" TO app_runtime;

-- Custo estimado por mensagem (dólar por categoria + câmbio). Nulo = usa o padrão do código.
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "custoMarketingUsd" DECIMAL(10,6);
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "custoUtilidadeUsd" DECIMAL(10,6);
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "cambioUsdBrl" DECIMAL(10,4);

-- ID do app da Meta (para enviar a imagem de exemplo de templates com cabeçalho de imagem)
ALTER TABLE "WhatsAppAccount" ADD COLUMN IF NOT EXISTS "appId" TEXT;

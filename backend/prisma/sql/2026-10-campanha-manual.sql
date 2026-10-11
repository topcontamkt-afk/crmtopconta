-- Campanha manual (lista de planilha): destinatários guardados para análise e envio sem cliente
-- obrigatório. Rodar no SQL Editor do Supabase ANTES de publicar o backend novo.
-- Só adiciona: coluna nova em Campaign, tabela nova, e afrouxa MessageEvent.clientId (agora opcional).

ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "manual" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "CampaignRecipient" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "telefone" TEXT NOT NULL,
    "cpfHash" TEXT,
    "cpfMasked" TEXT,
    "limiteDisponivel" DECIMAL(14,2),
    "clientId" TEXT,
    "optOutAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignRecipient_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CampaignRecipient_campaignId_telefone_key" ON "CampaignRecipient"("campaignId", "telefone");
CREATE INDEX IF NOT EXISTS "CampaignRecipient_tenantId_cpfHash_idx" ON "CampaignRecipient"("tenantId", "cpfHash");
CREATE INDEX IF NOT EXISTS "CampaignRecipient_tenantId_telefone_idx" ON "CampaignRecipient"("tenantId", "telefone");
CREATE INDEX IF NOT EXISTS "CampaignRecipient_clientId_idx" ON "CampaignRecipient"("clientId");

ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- MessageEvent: cliente opcional + vínculo com o destinatário da lista
ALTER TABLE "MessageEvent" ALTER COLUMN "clientId" DROP NOT NULL;
ALTER TABLE "MessageEvent" ADD COLUMN IF NOT EXISTS "recipientId" TEXT;
CREATE INDEX IF NOT EXISTS "MessageEvent_recipientId_idx" ON "MessageEvent"("recipientId");
ALTER TABLE "MessageEvent" ADD CONSTRAINT "MessageEvent_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "CampaignRecipient"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- (a FK MessageEvent_clientId_fkey continua; com a coluna opcional o Prisma usa ON DELETE SET NULL)
ALTER TABLE "MessageEvent" DROP CONSTRAINT IF EXISTS "MessageEvent_clientId_fkey";
ALTER TABLE "MessageEvent" ADD CONSTRAINT "MessageEvent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS: mesma policy das demais tabelas com tenantId
ALTER TABLE "CampaignRecipient" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "CampaignRecipient"
  FOR ALL
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "CampaignRecipient" TO app_runtime;

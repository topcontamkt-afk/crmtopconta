-- Inbox do WhatsApp, Fase 2: cópia local das mídias recebidas (services/whatsappMedia.ts).
-- Rodar no SQL Editor do Supabase ANTES de publicar o backend novo. Só cria uma tabela nova.

-- CreateTable
CREATE TABLE "WaMediaBlob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaMediaBlob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WaMediaBlob_messageId_key" ON "WaMediaBlob"("messageId");

-- CreateIndex
CREATE INDEX "WaMediaBlob_tenantId_idx" ON "WaMediaBlob"("tenantId");

-- AddForeignKey
ALTER TABLE "WaMediaBlob" ADD CONSTRAINT "WaMediaBlob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "WaMediaBlob" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "WaMediaBlob"
  FOR ALL
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "WaMediaBlob" TO app_runtime;

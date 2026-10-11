-- Inbox do WhatsApp, Fase 1 (services/whatsappInbox.ts): conta/número, conversas e mensagens.
-- Rodar no SQL Editor do Supabase ANTES de publicar o backend novo. Só cria tabelas novas.
-- Gerado com `prisma migrate diff` contra o schema anterior + RLS e GRANT (mesma policy das
-- demais tabelas; sem o GRANT o role app_runtime não consegue gravar).

-- CreateEnum
CREATE TYPE "WaDirection" AS ENUM ('ENTRADA', 'SAIDA');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('ABERTA', 'ARQUIVADA');

-- CreateTable
CREATE TABLE "WhatsAppAccount" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "wabaId" TEXT,
    "displayName" TEXT,
    "displayPhone" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "clientId" TEXT,
    "waId" TEXT NOT NULL,
    "contactName" TEXT,
    "status" "ConversationStatus" NOT NULL DEFAULT 'ABERTA',
    "lastMessageAt" TIMESTAMP(3) NOT NULL,
    "lastInboundAt" TIMESTAMP(3),
    "lastPreview" TEXT,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "assignedUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WaMessage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" "WaDirection" NOT NULL,
    "wamid" TEXT,
    "type" TEXT NOT NULL,
    "body" TEXT,
    "mediaId" TEXT,
    "mediaMime" TEXT,
    "mediaFilename" TEXT,
    "status" TEXT,
    "errorText" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppAccount_phoneNumberId_key" ON "WhatsAppAccount"("phoneNumberId");

-- CreateIndex
CREATE INDEX "WhatsAppAccount_tenantId_idx" ON "WhatsAppAccount"("tenantId");

-- CreateIndex
CREATE INDEX "Conversation_tenantId_lastMessageAt_idx" ON "Conversation"("tenantId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "Conversation_tenantId_clientId_idx" ON "Conversation"("tenantId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_accountId_waId_key" ON "Conversation"("accountId", "waId");

-- CreateIndex
CREATE INDEX "WaMessage_conversationId_timestamp_idx" ON "WaMessage"("conversationId", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "WaMessage_tenantId_wamid_key" ON "WaMessage"("tenantId", "wamid");

-- AddForeignKey
ALTER TABLE "WhatsAppAccount" ADD CONSTRAINT "WhatsAppAccount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaMessage" ADD CONSTRAINT "WaMessage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaMessage" ADD CONSTRAINT "WaMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "WhatsAppAccount" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "WhatsAppAccount"
  FOR ALL
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "WhatsAppAccount" TO app_runtime;

ALTER TABLE "Conversation" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "Conversation"
  FOR ALL
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "Conversation" TO app_runtime;

ALTER TABLE "WaMessage" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "WaMessage"
  FOR ALL
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "WaMessage" TO app_runtime;

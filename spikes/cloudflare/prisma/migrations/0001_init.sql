-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "cpfSalt" TEXT NOT NULL,
    "retentionDays" INTEGER NOT NULL DEFAULT 1095,
    "maxMsgsPerMinute" INTEGER NOT NULL DEFAULT 600,
    "custoMarketingUsd" DECIMAL,
    "custoUtilidadeUsd" DECIMAL,
    "cambioUsdBrl" DECIMAL,
    "whatsappProvider" TEXT NOT NULL DEFAULT 'META',
    "baseLegalMarketing" TEXT,
    "liaVersao" TEXT,
    "liaAprovadaEm" DATETIME,
    "controladorNome" TEXT,
    "encarregadoNome" TEXT,
    "encarregadoContato" TEXT,
    "avisoPrivacidadeUrl" TEXT,
    "rodapeOptOut" TEXT,
    "retentionBasis" TEXT,
    "retentionDaysAfterClosure" INTEGER,
    "inboxRetentionDays" INTEGER,
    "mediaRetentionDays" INTEGER NOT NULL DEFAULT 90,
    "correcaoManualVence" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'VIEWER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "areasRestritas" BOOLEAN NOT NULL DEFAULT false,
    "areas" JSONB NOT NULL DEFAULT [],
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" DATETIME,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "twoFactorSecret" TEXT,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "externalId" TEXT,
    "nome" TEXT NOT NULL,
    "telefone" TEXT NOT NULL,
    "email" TEXT,
    "cpfHash" TEXT NOT NULL,
    "cpfMasked" TEXT NOT NULL,
    "documentoTipo" TEXT,
    "cidade" TEXT,
    "dataCadastro" DATETIME,
    "dataAberturaConta" DATETIME,
    "limiteTotal" DECIMAL NOT NULL DEFAULT 0,
    "valorUtilizado" DECIMAL NOT NULL DEFAULT 0,
    "saldoDisponivel" DECIMAL NOT NULL DEFAULT 0,
    "valorAntecipado" DECIMAL NOT NULL DEFAULT 0,
    "dataUltimaUtilizacao" DATETIME,
    "ultimoUsoReal" DATETIME,
    "usosUltimos90d" INTEGER NOT NULL DEFAULT 0,
    "usosTotal" INTEGER NOT NULL DEFAULT 0,
    "diaCicloAbertura" INTEGER,
    "percentualUtilizado" DECIMAL NOT NULL DEFAULT 0,
    "faixaUso" TEXT NOT NULL DEFAULT 'SEM_USO',
    "statusConta" TEXT NOT NULL DEFAULT 'ATIVO',
    "origemCliente" TEXT,
    "autorizacaoComunicacao" BOOLEAN NOT NULL DEFAULT false,
    "optOutAt" DATETIME,
    "empresaConveniada" TEXT,
    "cidadeEmpresaConveniada" TEXT,
    "vinculoEmpregaticio" TEXT,
    "statusValidacaoCadastro" TEXT,
    "encerradoEm" DATETIME,
    "motivoEncerramento" TEXT,
    "obsEncerramento" TEXT,
    "razaoSocial" TEXT,
    "lotacao" TEXT,
    "dataValidadeCartao" DATETIME,
    "dataNascimento" DATETIME,
    "sexo" TEXT,
    "remuneracaoBruta" DECIMAL,
    "remuneracaoLiquida" DECIMAL,
    "bonus" DECIMAL,
    "saldoLiquidoSaque" DECIMAL,
    "tags" JSONB NOT NULL DEFAULT [],
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastImportJobId" TEXT,
    "anonymizedAt" DATETIME,
    "bloqueadoLgpdAt" DATETIME,
    "camposCorrigidos" JSONB,
    CONSTRAINT "Client_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ImportJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'google_sheets',
    "sheetId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDENTE',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "addedCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "triggeredBy" TEXT,
    "formato" TEXT,
    "loteId" TEXT,
    "nomeArquivo" TEXT,
    "desfeitaEm" DATETIME,
    "desfeitaPor" TEXT,
    CONSTRAINT "ImportJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ImportChange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "importJobId" TEXT NOT NULL,
    "loteId" TEXT,
    "clientId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "before" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ImportChange_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ImportChange_importJobId_fkey" FOREIGN KEY ("importJobId") REFERENCES "ImportJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Movement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "valor" DECIMAL NOT NULL,
    "data" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Movement_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AccountSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "limiteTotal" DECIMAL NOT NULL,
    "saldoDisponivel" DECIMAL NOT NULL,
    "saldoAnterior" DECIMAL,
    "valorUtilizado" DECIMAL NOT NULL,
    "statusConta" TEXT NOT NULL,
    "importJobId" TEXT,
    CONSTRAINT "AccountSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AccountSnapshot_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SegmentDefinition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "operator" TEXT NOT NULL DEFAULT 'AND',
    "lastCount" INTEGER,
    "dynamic" BOOLEAN NOT NULL DEFAULT true,
    "refreshCron" TEXT NOT NULL DEFAULT '0 * * * *',
    "lastRefreshedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SegmentDefinition_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "objective" TEXT,
    "channel" TEXT NOT NULL,
    "segmentId" TEXT,
    "adHocFilters" JSONB,
    "templateId" TEXT,
    "messageTemplate" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RASCUNHO',
    "messageTemplateB" TEXT,
    "variantSplitPercent" INTEGER,
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "isSandbox" BOOLEAN NOT NULL DEFAULT false,
    "baseLegal" TEXT,
    "consentimentoOrigem" TEXT,
    "consentimentoPor" TEXT,
    "consentimentoEm" DATETIME,
    "scheduledAt" DATETIME,
    "throttlePerMin" INTEGER NOT NULL DEFAULT 60,
    "dedupeWindowHrs" INTEGER NOT NULL DEFAULT 72,
    "attributionDays" INTEGER NOT NULL DEFAULT 7,
    "controlGroupPercent" INTEGER,
    "costPerMessage" DECIMAL NOT NULL DEFAULT 0,
    "audienceCount" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Campaign_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Campaign_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "SegmentDefinition" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Campaign_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "MessageTemplate" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MessageEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "clientId" TEXT,
    "recipientId" TEXT,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'FILA',
    "variant" TEXT NOT NULL DEFAULT 'A',
    "provider" TEXT,
    "providerMsgId" TEXT,
    "cost" DECIMAL NOT NULL DEFAULT 0,
    "error" TEXT,
    "queuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" DATETIME,
    "deliveredAt" DATETIME,
    "respondedAt" DATETIME,
    "convertedAt" DATETIME,
    "convertedValue" DECIMAL,
    "clickedAt" DATETIME,
    "clickCount" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "MessageEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MessageEvent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MessageEvent_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "CampaignRecipient" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CampaignRecipient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "telefone" TEXT NOT NULL,
    "cpfHash" TEXT,
    "cpfMasked" TEXT,
    "limiteDisponivel" DECIMAL,
    "clientId" TEXT,
    "optOutAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CampaignRecipient_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CampaignRecipient_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AutomationRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "condition" JSONB,
    "action" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "lastRunAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AutomationRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "targetId" TEXT,
    "details" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "prevHash" TEXT,
    "hash" TEXT,
    CONSTRAINT "AuditLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SheetConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "sheetId" TEXT NOT NULL,
    "sheetRange" TEXT NOT NULL DEFAULT 'A1:Z',
    "authType" TEXT NOT NULL DEFAULT 'service_account',
    "columnMapping" JSONB NOT NULL,
    "cronSchedule" TEXT NOT NULL DEFAULT '0 6 * * 1,4',
    "lastSyncAt" DATETIME,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SheetConnection_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ChannelConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "credentials" JSONB NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "webhookSecret" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChannelConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MessageTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RASCUNHO',
    "providerTemplateId" TEXT,
    "rejectionReason" TEXT,
    "language" TEXT NOT NULL DEFAULT 'pt_BR',
    "category" TEXT,
    "footer" TEXT,
    "quickReplies" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "metaName" TEXT,
    "metaStatus" TEXT,
    "qualityScore" TEXT,
    "submittedAt" DATETIME,
    "headerFormat" TEXT,
    "headerHandle" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'LOCAL',
    "metaBody" TEXT,
    "variableMap" JSONB,
    "buttons" JSONB,
    "sendIssue" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MessageTemplate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TemplateMedia" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BLOB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TemplateMedia_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TemplateMedia_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "MessageTemplate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'INFO',
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "relatedType" TEXT,
    "relatedId" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DashboardSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "day" DATETIME NOT NULL,
    "totalClientes" INTEGER NOT NULL,
    "ativos" INTEGER NOT NULL,
    "inativos" INTEGER NOT NULL,
    "bloqueados" INTEGER NOT NULL,
    "semUso" INTEGER NOT NULL,
    "limiteTotal" DECIMAL NOT NULL,
    "valorUtilizado" DECIMAL NOT NULL,
    "saldoDisponivel" DECIMAL NOT NULL,
    "usaramNoDia" INTEGER NOT NULL DEFAULT 0,
    "encerradosNoDia" INTEGER NOT NULL DEFAULT 0,
    "faixas" JSONB NOT NULL,
    "healthScore" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DashboardSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Merchant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'OUTROS',
    "categorySource" TEXT NOT NULL DEFAULT 'AUTO',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Merchant_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Purchase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "merchantId" TEXT,
    "externalId" TEXT NOT NULL,
    "occurredAt" DATETIME NOT NULL,
    "tipo" TEXT NOT NULL,
    "merchantName" TEXT,
    "valorPrincipal" DECIMAL NOT NULL,
    "valorParcela" DECIMAL,
    "juros" DECIMAL,
    "razaoSocial" TEXT,
    "importJobId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Purchase_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Purchase_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Purchase_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WhatsAppAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'META',
    "phoneNumberId" TEXT NOT NULL,
    "wabaId" TEXT,
    "appId" TEXT,
    "displayName" TEXT,
    "displayPhone" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "credentials" JSONB,
    "accessTokenHint" TEXT,
    "appSecretHint" TEXT,
    "verifyToken" TEXT,
    "lastCheckAt" DATETIME,
    "lastCheckOk" BOOLEAN,
    "lastCheckMessage" TEXT,
    "autoReplyEnabled" BOOLEAN NOT NULL DEFAULT true,
    "autoReplyText" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WhatsAppAccount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "clientId" TEXT,
    "waId" TEXT NOT NULL,
    "contactName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ABERTA',
    "lastMessageAt" DATETIME NOT NULL,
    "lastInboundAt" DATETIME,
    "lastPreview" TEXT,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "assignedUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Conversation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Conversation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Conversation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WaMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "wamid" TEXT,
    "type" TEXT NOT NULL,
    "body" TEXT,
    "mediaId" TEXT,
    "mediaMime" TEXT,
    "mediaFilename" TEXT,
    "status" TEXT,
    "sentByUserId" TEXT,
    "automatic" BOOLEAN NOT NULL DEFAULT false,
    "errorText" TEXT,
    "timestamp" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WaMessage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "WaMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WaMediaBlob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BLOB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WaMediaBlob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SupressaoTitular" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "phoneHash" TEXT,
    "docHash" TEXT,
    "motivo" TEXT NOT NULL,
    "canal" TEXT,
    "origem" TEXT NOT NULL,
    "pedidoId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SupressaoTitular_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PedidoTitular" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT,
    "telefoneMasked" TEXT,
    "tipo" TEXT NOT NULL,
    "canal" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ABERTO',
    "descricao" TEXT,
    "recebidoEm" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "prazoEm" DATETIME NOT NULL,
    "respondidoEm" DATETIME,
    "resposta" TEXT,
    "userId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PedidoTitular_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CicloCidade" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "cidadeKey" TEXT NOT NULL,
    "cidade" TEXT NOT NULL,
    "diaAbertura" INTEGER NOT NULL,
    "diaFechamento" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CicloCidade_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Client_tenantId_telefone_idx" ON "Client"("tenantId", "telefone");

-- CreateIndex
CREATE INDEX "Client_tenantId_cidade_idx" ON "Client"("tenantId", "cidade");

-- CreateIndex
CREATE INDEX "Client_tenantId_diaCicloAbertura_idx" ON "Client"("tenantId", "diaCicloAbertura");

-- CreateIndex
CREATE INDEX "Client_tenantId_faixaUso_idx" ON "Client"("tenantId", "faixaUso");

-- CreateIndex
CREATE INDEX "Client_tenantId_ultimoUsoReal_idx" ON "Client"("tenantId", "ultimoUsoReal");

-- CreateIndex
CREATE INDEX "Client_tenantId_statusConta_idx" ON "Client"("tenantId", "statusConta");

-- CreateIndex
CREATE UNIQUE INDEX "Client_tenantId_cpfHash_key" ON "Client"("tenantId", "cpfHash");

-- CreateIndex
CREATE INDEX "ImportJob_tenantId_loteId_idx" ON "ImportJob"("tenantId", "loteId");

-- CreateIndex
CREATE INDEX "ImportChange_tenantId_loteId_idx" ON "ImportChange"("tenantId", "loteId");

-- CreateIndex
CREATE INDEX "ImportChange_importJobId_idx" ON "ImportChange"("importJobId");

-- CreateIndex
CREATE INDEX "Movement_clientId_data_idx" ON "Movement"("clientId", "data");

-- CreateIndex
CREATE INDEX "AccountSnapshot_tenantId_clientId_recordedAt_idx" ON "AccountSnapshot"("tenantId", "clientId", "recordedAt");

-- CreateIndex
CREATE INDEX "AccountSnapshot_tenantId_recordedAt_idx" ON "AccountSnapshot"("tenantId", "recordedAt");

-- CreateIndex
CREATE INDEX "MessageEvent_campaignId_status_idx" ON "MessageEvent"("campaignId", "status");

-- CreateIndex
CREATE INDEX "MessageEvent_clientId_idx" ON "MessageEvent"("clientId");

-- CreateIndex
CREATE INDEX "MessageEvent_recipientId_idx" ON "MessageEvent"("recipientId");

-- CreateIndex
CREATE INDEX "CampaignRecipient_tenantId_cpfHash_idx" ON "CampaignRecipient"("tenantId", "cpfHash");

-- CreateIndex
CREATE INDEX "CampaignRecipient_tenantId_telefone_idx" ON "CampaignRecipient"("tenantId", "telefone");

-- CreateIndex
CREATE INDEX "CampaignRecipient_clientId_idx" ON "CampaignRecipient"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRecipient_campaignId_telefone_key" ON "CampaignRecipient"("campaignId", "telefone");

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_createdAt_idx" ON "AuditLog"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "ChannelConfig_tenantId_channel_priority_idx" ON "ChannelConfig"("tenantId", "channel", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelConfig_tenantId_channel_provider_key" ON "ChannelConfig"("tenantId", "channel", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "MessageTemplate_tenantId_channel_name_key" ON "MessageTemplate"("tenantId", "channel", "name");

-- CreateIndex
CREATE UNIQUE INDEX "TemplateMedia_templateId_key" ON "TemplateMedia"("templateId");

-- CreateIndex
CREATE INDEX "Notification_tenantId_read_createdAt_idx" ON "Notification"("tenantId", "read", "createdAt");

-- CreateIndex
CREATE INDEX "DashboardSnapshot_tenantId_day_idx" ON "DashboardSnapshot"("tenantId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "DashboardSnapshot_tenantId_day_key" ON "DashboardSnapshot"("tenantId", "day");

-- CreateIndex
CREATE INDEX "Merchant_tenantId_category_idx" ON "Merchant"("tenantId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_tenantId_nameKey_key" ON "Merchant"("tenantId", "nameKey");

-- CreateIndex
CREATE INDEX "Purchase_tenantId_occurredAt_idx" ON "Purchase"("tenantId", "occurredAt");

-- CreateIndex
CREATE INDEX "Purchase_clientId_occurredAt_idx" ON "Purchase"("clientId", "occurredAt");

-- CreateIndex
CREATE INDEX "Purchase_merchantId_occurredAt_idx" ON "Purchase"("merchantId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "Purchase_tenantId_externalId_key" ON "Purchase"("tenantId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppAccount_phoneNumberId_key" ON "WhatsAppAccount"("phoneNumberId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppAccount_verifyToken_key" ON "WhatsAppAccount"("verifyToken");

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

-- CreateIndex
CREATE UNIQUE INDEX "WaMediaBlob_messageId_key" ON "WaMediaBlob"("messageId");

-- CreateIndex
CREATE INDEX "WaMediaBlob_tenantId_idx" ON "WaMediaBlob"("tenantId");

-- CreateIndex
CREATE INDEX "SupressaoTitular_tenantId_phoneHash_idx" ON "SupressaoTitular"("tenantId", "phoneHash");

-- CreateIndex
CREATE INDEX "SupressaoTitular_tenantId_docHash_idx" ON "SupressaoTitular"("tenantId", "docHash");

-- CreateIndex
CREATE INDEX "PedidoTitular_tenantId_status_idx" ON "PedidoTitular"("tenantId", "status");

-- CreateIndex
CREATE INDEX "PedidoTitular_tenantId_clientId_idx" ON "PedidoTitular"("tenantId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "CicloCidade_tenantId_cidadeKey_key" ON "CicloCidade"("tenantId", "cidadeKey");

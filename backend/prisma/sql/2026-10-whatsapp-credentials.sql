-- Configuração do WhatsApp pela tela de Integrações: credenciais cifradas e token de verificação por
-- conta (WhatsAppAccount). Rodar no SQL Editor do Supabase ANTES de publicar o backend novo. Só adiciona
-- colunas anuláveis e um índice único (o token de verificação).
-- AlterTable
ALTER TABLE "WhatsAppAccount" ADD COLUMN     "accessTokenHint" TEXT,
ADD COLUMN     "appSecretHint" TEXT,
ADD COLUMN     "credentials" JSONB,
ADD COLUMN     "lastCheckAt" TIMESTAMP(3),
ADD COLUMN     "lastCheckMessage" TEXT,
ADD COLUMN     "lastCheckOk" BOOLEAN,
ADD COLUMN     "verifyToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppAccount_verifyToken_key" ON "WhatsAppAccount"("verifyToken");


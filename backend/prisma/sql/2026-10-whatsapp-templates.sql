-- Inbox do WhatsApp, Fase 4: campos de template da Meta em MessageTemplate. Rodar no SQL Editor do
-- Supabase ANTES de publicar o backend novo. Só adiciona colunas (com padrão ou anuláveis).
-- AlterTable
ALTER TABLE "MessageTemplate" ADD COLUMN     "category" TEXT,
ADD COLUMN     "footer" TEXT,
ADD COLUMN     "language" TEXT NOT NULL DEFAULT 'pt_BR',
ADD COLUMN     "metaName" TEXT,
ADD COLUMN     "metaStatus" TEXT,
ADD COLUMN     "qualityScore" TEXT,
ADD COLUMN     "quickReplies" JSONB,
ADD COLUMN     "submittedAt" TIMESTAMP(3),
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;


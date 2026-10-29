-- Resposta automática da Inbox: quantidade máxima por conversa e janela em horas, configuráveis por conta.
-- Padrão 3 por 24 h (o comportamento anterior). ADD COLUMN com DEFAULT não mexe nas linhas existentes.
ALTER TABLE "WhatsAppAccount" ADD COLUMN "autoReplyMax" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "WhatsAppAccount" ADD COLUMN "autoReplyJanelaHoras" INTEGER NOT NULL DEFAULT 24;

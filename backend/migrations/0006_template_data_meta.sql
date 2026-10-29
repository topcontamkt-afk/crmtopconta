-- Data de atualização do template informada pela Meta (last_updated_time), usada para ordenar a lista de templates.
ALTER TABLE "MessageTemplate" ADD COLUMN "metaUpdatedAt" DATETIME;

-- Mídias saem do banco para o R2 (services/mediaStore.ts): `data` (Bytes) vira `storageKey`.
-- Gerado por prisma migrate diff e ajustado à mão (INSERTs e PRAGMA foreign_keys, que o D1 não aceita trocar).
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
CREATE TABLE "new_TemplateMedia" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TemplateMedia_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TemplateMedia_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "MessageTemplate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- (ajuste manual) linhas antigas recebem a chave padrão; sem objeto no R2, a imagem conta como ausente
INSERT INTO "new_TemplateMedia" ("createdAt", "filename", "id", "mime", "size", "storageKey", "templateId", "tenantId", "updatedAt") SELECT "createdAt", "filename", "id", "mime", "size", 't/' || "tenantId" || '/tpl/' || "templateId", "templateId", "tenantId", "updatedAt" FROM "TemplateMedia";
DROP TABLE "TemplateMedia";
ALTER TABLE "new_TemplateMedia" RENAME TO "TemplateMedia";
CREATE UNIQUE INDEX "TemplateMedia_templateId_key" ON "TemplateMedia"("templateId");
CREATE TABLE "new_WaMediaBlob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WaMediaBlob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
-- (ajuste manual) idem: sem objeto no R2, a mídia é buscada de novo na Meta
INSERT INTO "new_WaMediaBlob" ("createdAt", "id", "messageId", "mime", "size", "storageKey", "tenantId") SELECT "createdAt", "id", "messageId", "mime", "size", 't/' || "tenantId" || '/wa/' || "messageId", "tenantId" FROM "WaMediaBlob";
DROP TABLE "WaMediaBlob";
ALTER TABLE "new_WaMediaBlob" RENAME TO "WaMediaBlob";
CREATE UNIQUE INDEX "WaMediaBlob_messageId_key" ON "WaMediaBlob"("messageId");
CREATE INDEX "WaMediaBlob_tenantId_idx" ON "WaMediaBlob"("tenantId");
PRAGMA defer_foreign_keys=OFF;

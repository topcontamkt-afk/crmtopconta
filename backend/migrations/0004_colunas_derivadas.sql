-- Colunas derivadas para o SQL cru do SQLite (sem regex e sem lower() fora do ASCII): Client.cidadeKey,
-- Client.nomeBusca e Purchase.usoTipo, calculadas em JS a cada gravação (src/config/derivedColumns.ts).
--
-- Escrita à mão: o `prisma migrate diff` gerou a recriação das tabelas (CREATE new_ / INSERT / DROP / RENAME).
-- No D1 o DROP TABLE "Client" faz um DELETE implícito que dispara os ON DELETE CASCADE (ClientTag...), e o D1
-- não aceita desligar as chaves estrangeiras. ADD COLUMN com DEFAULT não mexe nas linhas filhas.
--
-- Linhas que já existirem ficam com o valor padrão; o backfill aproximado abaixo cobre a homologação (o lower() do
-- SQLite só baixa a caixa em ASCII). Regravar a cidade/nome/tipo pelo app recalcula o valor exato.

ALTER TABLE "Client" ADD COLUMN "nomeBusca" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Client" ADD COLUMN "cidadeKey" TEXT NOT NULL DEFAULT '__SEM_CIDADE__';
ALTER TABLE "Purchase" ADD COLUMN "usoTipo" TEXT NOT NULL DEFAULT 'OUTRO';

UPDATE "Client" SET "nomeBusca" = lower(trim("nome"));
UPDATE "Client" SET "cidadeKey" = lower(trim("cidade")) WHERE trim(coalesce("cidade", '')) <> '';
UPDATE "Purchase" SET "usoTipo" = CASE
  WHEN lower(trim("tipo")) LIKE 'debito pix%' OR lower(trim("tipo")) LIKE 'débito pix%' OR lower(trim("tipo")) LIKE 'dÉbito pix%' THEN 'ANTECIPACAO'
  WHEN lower(trim("tipo")) LIKE 'compra a vista%' OR lower(trim("tipo")) LIKE 'compra à vista%' OR lower(trim("tipo")) LIKE 'compra À vista%' THEN 'COMPRA'
  WHEN lower(trim("tipo")) LIKE 'assinatura%' THEN 'ASSINATURA'
  ELSE 'OUTRO' END;

CREATE INDEX "Client_tenantId_cidadeKey_idx" ON "Client"("tenantId", "cidadeKey");
CREATE INDEX "Purchase_tenantId_usoTipo_occurredAt_idx" ON "Purchase"("tenantId", "usoTipo", "occurredAt");

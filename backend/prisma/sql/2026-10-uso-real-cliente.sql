-- Uso real do cliente pelo extrato (services/etapaUso.ts + usageRefresh.ts). Rodar no SQL Editor
-- do Supabase ANTES de publicar o backend novo. Só adiciona colunas com padrão: não mexe em dados
-- nem em RLS (a tabela Client já tem).
ALTER TABLE "Client" ADD COLUMN IF NOT EXISTS "ultimoUsoReal" TIMESTAMP(3);
ALTER TABLE "Client" ADD COLUMN IF NOT EXISTS "usosUltimos90d" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Client" ADD COLUMN IF NOT EXISTS "usosTotal" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS "Client_tenantId_ultimoUsoReal_idx" ON "Client"("tenantId", "ultimoUsoReal");

-- Carga inicial a partir do extrato já importado (o app refaz isso a cada importação e 1x/dia).
UPDATE "Client" c SET "ultimoUsoReal" = s.ult, "usosUltimos90d" = s.n90, "usosTotal" = s.tot
FROM (
  SELECT "clientId", MAX("occurredAt") AS ult,
         COUNT(*) FILTER (WHERE "occurredAt" >= now() - interval '90 days')::int AS n90,
         COUNT(*)::int AS tot
  FROM "Purchase"
  WHERE "tipo" ~* '^\s*d[eé]bito\s+pix' OR "tipo" ~* '^\s*compra\s+[àa]\s+vista'
  GROUP BY "clientId"
) s
WHERE c.id = s."clientId";

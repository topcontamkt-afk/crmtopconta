-- Novas faixas de uso do limite: 0%, 1-10, 11-20, 21-30, 31-50, 51-70, 71-99 e 100%.
-- Substitui as faixas antigas (NAO_UTILIZOU, BAIXO_USO, USO_INICIAL, USO_INTERMEDIARIO, USO_ALTO,
-- QUASE_COMPLETO, LIMITE_COMPLETO). Rodar no Supabase (SQL Editor) ANTES de publicar o backend
-- novo — ou logo em seguida: entre uma coisa e outra, filtros por faixa ficam fora do ar.
--
-- Os clientes já importados são reclassificados pelo percentualUtilizado/limiteTotal gravado
-- (mesma regra de backend/src/services/usage.ts: <=10, <=20, <=30, <=50, <=70, <100, >=100).
-- Tudo numa transação: se algo falhar, nada é aplicado.

BEGIN;

CREATE TYPE "UsageFaixa_new" AS ENUM (
  'SEM_USO', 'USO_1_10', 'USO_11_20', 'USO_21_30', 'USO_31_50', 'USO_51_70', 'USO_71_99', 'USO_100', 'INDEFINIDO'
);

ALTER TABLE "Client" ALTER COLUMN "faixaUso" DROP DEFAULT;

ALTER TABLE "Client" ALTER COLUMN "faixaUso" TYPE "UsageFaixa_new" USING (
  CASE
    WHEN "limiteTotal" IS NULL OR "limiteTotal" <= 0 THEN 'INDEFINIDO'
    WHEN "percentualUtilizado" <= 0 THEN 'SEM_USO'
    WHEN "percentualUtilizado" <= 10 THEN 'USO_1_10'
    WHEN "percentualUtilizado" <= 20 THEN 'USO_11_20'
    WHEN "percentualUtilizado" <= 30 THEN 'USO_21_30'
    WHEN "percentualUtilizado" <= 50 THEN 'USO_31_50'
    WHEN "percentualUtilizado" <= 70 THEN 'USO_51_70'
    WHEN "percentualUtilizado" < 100 THEN 'USO_71_99'
    ELSE 'USO_100'
  END
)::"UsageFaixa_new";

ALTER TABLE "Client" ALTER COLUMN "faixaUso" SET DEFAULT 'SEM_USO';

DROP TYPE "UsageFaixa";
ALTER TYPE "UsageFaixa_new" RENAME TO "UsageFaixa";

-- Filtros salvos que citam as faixas antigas (listas: cada faixa antiga vira as novas que a cobrem).
UPDATE "SegmentDefinition" SET "filters" = (
  replace(replace(replace(replace(replace(replace(replace("filters"::text,
    '"NAO_UTILIZOU"',      '"SEM_USO"'),
    '"BAIXO_USO"',         '"USO_1_10","USO_11_20"'),
    '"USO_INICIAL"',       '"USO_21_30","USO_31_50"'),
    '"USO_INTERMEDIARIO"', '"USO_31_50","USO_51_70"'),
    '"USO_ALTO"',          '"USO_71_99"'),
    '"QUASE_COMPLETO"',    '"USO_71_99"'),
    '"LIMITE_COMPLETO"',   '"USO_100"')
)::jsonb
WHERE "filters"::text ~ '"(NAO_UTILIZOU|BAIXO_USO|USO_INICIAL|USO_INTERMEDIARIO|USO_ALTO|QUASE_COMPLETO|LIMITE_COMPLETO)"';

UPDATE "Campaign" SET "adHocFilters" = (
  replace(replace(replace(replace(replace(replace(replace("adHocFilters"::text,
    '"NAO_UTILIZOU"',      '"SEM_USO"'),
    '"BAIXO_USO"',         '"USO_1_10","USO_11_20"'),
    '"USO_INICIAL"',       '"USO_21_30","USO_31_50"'),
    '"USO_INTERMEDIARIO"', '"USO_31_50","USO_51_70"'),
    '"USO_ALTO"',          '"USO_71_99"'),
    '"QUASE_COMPLETO"',    '"USO_71_99"'),
    '"LIMITE_COMPLETO"',   '"USO_100"')
)::jsonb
WHERE "adHocFilters" IS NOT NULL
  AND "adHocFilters"::text ~ '"(NAO_UTILIZOU|BAIXO_USO|USO_INICIAL|USO_INTERMEDIARIO|USO_ALTO|QUASE_COMPLETO|LIMITE_COMPLETO)"';

-- Automações "Estímulo por faixa de uso": a condição guarda UMA faixa (texto), então o mapeamento é 1 para 1.
UPDATE "AutomationRule" SET "condition" = jsonb_set("condition", '{faixa}', to_jsonb(
  CASE "condition"->>'faixa'
    WHEN 'NAO_UTILIZOU'      THEN 'SEM_USO'
    WHEN 'BAIXO_USO'         THEN 'USO_1_10'
    WHEN 'USO_INICIAL'       THEN 'USO_21_30'
    WHEN 'USO_INTERMEDIARIO' THEN 'USO_51_70'
    WHEN 'USO_ALTO'          THEN 'USO_71_99'
    WHEN 'QUASE_COMPLETO'    THEN 'USO_71_99'
    WHEN 'LIMITE_COMPLETO'   THEN 'USO_100'
  END
))
WHERE "condition"->>'faixa' IN ('NAO_UTILIZOU','BAIXO_USO','USO_INICIAL','USO_INTERMEDIARIO','USO_ALTO','QUASE_COMPLETO','LIMITE_COMPLETO');

COMMIT;

-- Conferência (opcional): contagem de clientes por faixa nova.
-- SELECT "faixaUso", COUNT(*) FROM "Client" GROUP BY 1 ORDER BY 1;

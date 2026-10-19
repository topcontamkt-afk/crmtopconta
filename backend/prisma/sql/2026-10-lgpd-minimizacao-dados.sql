-- LGPD 01-01 (minimização): apaga dos clientes os campos importados que nenhuma tela, segmento, template ou
-- automação usa. Decisão 3 da triagem de 2026-10-18 (docs/lgpd/auditoria/2026-10-18/triagem.md).
--
-- *** DESTRUTIVO E IRREVERSÍVEL ***: os valores apagados só voltam reimportando a planilha de origem.
-- Rodar SÓ depois de publicar o backend que parou de importar esses campos (senão a próxima sincronização
-- os grava de novo) e depois de a controladora confirmar que nenhum deles tem uso concreto.
-- As colunas continuam existindo; a remoção do schema fica para uma migração posterior.

-- Conferência antes (quantos clientes têm algum valor em cada campo):
-- SELECT count(*) FILTER (WHERE "email" IS NOT NULL) AS email,
--        count(*) FILTER (WHERE "lotacao" IS NOT NULL) AS lotacao,
--        count(*) FILTER (WHERE "bonus" IS NOT NULL) AS bonus,
--        count(*) FILTER (WHERE "saldoLiquidoSaque" IS NOT NULL) AS saldo_saque,
--        count(*) FILTER (WHERE "vinculoEmpregaticio" IS NOT NULL) AS vinculo,
--        count(*) FILTER (WHERE "cidadeEmpresaConveniada" IS NOT NULL) AS cidade_conveniada,
--        count(*) FILTER (WHERE "obsEncerramento" IS NOT NULL) AS obs_encerramento,
--        count(*) FILTER (WHERE "motivoEncerramento" IS NOT NULL) AS motivo_encerramento,
--        count(*) FILTER (WHERE "razaoSocial" IS NOT NULL) AS razao_social,
--        count(*) FILTER (WHERE "statusValidacaoCadastro" IS NOT NULL) AS status_validacao
-- FROM "Client";

UPDATE "Client" SET
  "email" = NULL,
  "lotacao" = NULL,
  "bonus" = NULL,
  "saldoLiquidoSaque" = NULL,
  "vinculoEmpregaticio" = NULL,
  "cidadeEmpresaConveniada" = NULL,
  "obsEncerramento" = NULL,
  "motivoEncerramento" = NULL,
  "razaoSocial" = NULL,
  "statusValidacaoCadastro" = NULL
WHERE "email" IS NOT NULL OR "lotacao" IS NOT NULL OR "bonus" IS NOT NULL OR "saldoLiquidoSaque" IS NOT NULL
   OR "vinculoEmpregaticio" IS NOT NULL OR "cidadeEmpresaConveniada" IS NOT NULL OR "obsEncerramento" IS NOT NULL
   OR "motivoEncerramento" IS NOT NULL OR "razaoSocial" IS NOT NULL OR "statusValidacaoCadastro" IS NOT NULL;

-- As cópias desses campos no histórico de importação (ImportChange.before) também saem:
UPDATE "ImportChange" SET "before" = "before"
  - 'email' - 'lotacao' - 'bonus' - 'saldoLiquidoSaque' - 'vinculoEmpregaticio' - 'cidadeEmpresaConveniada'
  - 'obsEncerramento' - 'motivoEncerramento' - 'razaoSocial' - 'statusValidacaoCadastro'
WHERE "before" IS NOT NULL;

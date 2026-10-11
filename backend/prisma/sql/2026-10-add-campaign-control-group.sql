-- Grupo de controle de campanha (services/campaignQueue.ts, services/campaignResults.ts).
-- Aplicado em produção em 2026-10-10 (migrations add_message_status_controle e add_campaign_control_group_percent).
--
-- ATENÇÃO: o ALTER TYPE ... ADD VALUE abaixo NÃO pode rodar dentro de uma transação junto com
-- outros comandos em versões antigas do Postgres. Rode cada comando separadamente (um por vez)
-- ou, se o editor reclamar, rode só o primeiro, depois o segundo.

-- 1) novo status de MessageEvent: cliente do público que NÃO recebeu a mensagem
ALTER TYPE "MessageStatus" ADD VALUE IF NOT EXISTS 'CONTROLE';

-- 2) percentual do público reservado como controle (nulo/0 = desligado)
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "controlGroupPercent" INTEGER;

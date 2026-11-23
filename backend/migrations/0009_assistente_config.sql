-- Assistente de IA: provedor (Claude ou GPT) e modelo escolhidos em Configurações, por conta.
-- Coluna nova, nula: o código antigo a ignora e, sem ela, o assistente usa o padrão do ambiente.
ALTER TABLE "Tenant" ADD COLUMN "assistente" JSONB;

-- Assistente de IA: provedor (Claude ou GPT) e modelo escolhidos em Configurações, por conta.
-- Coluna nova, nula: sem ela o assistente usa o padrão do ambiente (ASSISTENTE_PROVEDOR/ASSISTENTE_MODELO) e a tela de
-- Configurações avisa que não consegue salvar. Rodar ANTES do deploy.
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "assistente" JSONB;

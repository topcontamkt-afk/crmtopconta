---
title: Inventário técnico do repositório CRM TopConta
date: 2026-09-10
type: repository-analysis
sources: []
---

# Inventário técnico do repositório CRM TopConta

## Escopo e segurança da fonte

Este documento foi produzido a partir da estrutura do repositório, documentação versionada, arquivos de configuração não sensíveis, schema Prisma, rotas, serviços, páginas frontend e testes. Arquivos `.env`, tokens, chaves, connection strings, dados reais de clientes, payloads reais e identificadores operacionais foram deliberadamente excluídos.

## Visão geral

CRM TopConta é um CRM comercial multi-tenant. O sistema importa uma base de clientes de Google Sheets ou CSV, valida e deduplica registros, calcula percentual e faixa de uso, cria segmentos, executa campanhas por WhatsApp e SMS e mantém controles de auditoria e conformidade com a LGPD.

O repositório possui dois pacotes npm independentes:

- `backend/`: API Express em TypeScript, Prisma e PostgreSQL.
- `frontend/`: SPA React em TypeScript, Vite e React Router.

Não existe um workspace npm unificado. Cada pacote possui ciclo de instalação, build e execução próprio.

## Entradas e deploy

`backend/src/app.ts` monta o Express, middleware e rotas, mas não inicia o servidor nem o scheduler. `backend/src/index.ts` é a entrada local persistente e pode iniciar o scheduler `node-cron`. `backend/api/index.ts` expõe o mesmo app como função serverless da Vercel.

No ambiente local, o banco é PostgreSQL via Docker Compose, o backend escuta na porta 4000 e o frontend Vite escuta na porta 5173 com proxy `/api`. Em produção, frontend e backend são projetos Vercel separados e o banco é Supabase PostgreSQL. Os cron jobs de produção chamam endpoints HTTP protegidos, pois funções serverless não mantêm um processo vivo.

## Backend

### Camadas

- `src/config/`: ambiente, Prisma, URLs de banco e guard de tenant.
- `src/middleware/`: autenticação JWT, autorização por papel, auditoria, rate limit e autenticação de cron.
- `src/routes/`: superfície HTTP por domínio.
- `src/services/`: regras de negócio e integrações externas.
- `prisma/`: schema, migrations e seed de desenvolvimento.

### Rotas principais

- Auth: login, 2FA, sessão, senha e configuração TOTP.
- Clients: consulta, exportação CSV, detalhe e atualizações em lote.
- Dashboard: resumo, uso mensal, encerramentos, engajamento, perfil e evolução.
- Imports: Google Sheets, CSV, formato de cartões e contas, qualidade e correção de erros.
- Segments: preview, criação, refresh e exclusão de segmentações.
- Campaigns: criação, preview de audiência, agendamento, dispatch, test-send e relatórios.
- Automations: CRUD de regras e ativação.
- Integrations: Sheets, canais, webhooks e exportação BI.
- Audit, users, templates, notifications e tenant settings.
- Cron: endpoints para dispatch, automações, refresh, sincronização, retenção e BI.

### Serviços de negócio

`importService.ts` é o pipeline principal de ingestão. `dedupe.ts` usa hash de CPF/CNPJ e fallback por telefone. `usage.ts` calcula percentual e faixas com divisão segura. `segments.ts` constrói filtros simples ou grupos recursivos AND/OR. `campaignQueue.ts` forma audiência, aplica opt-out, dedupe e throttle, grava `MessageEvent` e processa lotes. `automationEngine.ts` avalia gatilhos e ações configuradas. `statistics.ts` implementa o teste z de duas proporções para A/B testing.

`googleSheets.ts`, `biExport.ts`, `channels/whatsapp.ts` e `channels/sms.ts` encapsulam integrações externas atrás de interfaces. Adaptadores mock permitem desenvolvimento sem credenciais reais.

### Segurança e LGPD

- JWT com expiração e bloqueio de tokens pendentes de 2FA.
- TOTP para segundo fator.
- Papéis `ADMIN`, `OPERATOR`, `ANALYST` e `VIEWER`.
- Isolamento por `tenantId` nas consultas e guard de contexto.
- CPF/CNPJ não são persistidos em texto plano: o sistema usa HMAC por tenant para deduplicação e valor mascarado para exibição.
- Credenciais de canais são cifradas com AES-256-GCM e chave de aplicação.
- Opt-out é sticky e não é reativado silenciosamente por importações.
- Webhooks verificam assinaturas dos provedores.
- Ações sensíveis entram em `AuditLog`, com hash-chain para verificação de integridade.
- Retenção anonimiza clientes inativos além da política do tenant.

## Modelo de dados

O schema Prisma usa PostgreSQL e inclui binary target para execução local e runtime Linux da Vercel. As entidades centrais são `Tenant`, `User`, `Client`, `ImportJob`, `Movement`, `SegmentDefinition`, `Campaign`, `MessageEvent`, `AutomationRule`, `AuditLog`, `SheetConnection`, `ChannelConfig`, `MessageTemplate` e `Notification`.

`MessageEvent` funciona como fila persistida no próprio Postgres. `Movement` preserva histórico e permite detectar renovação de limite e atribuir conversões. Índices compostos por tenant apoiam deduplicação e filtros de segmentação.

## Frontend

`frontend/src/App.tsx` define layout, sidebar, rotas e gates de papel. `AuthContext.tsx` concentra o estado de autenticação. `api/client.ts` centraliza chamadas HTTP, token e downloads autenticados. As páginas cobrem login, dashboard, clientes, perfil, segmentos, campanhas, templates, automações, importações, integrações, auditoria, usuários, configurações e conta.

Rotas administrativas possuem proteção de interface, mas o backend continua sendo a autoridade de autorização. O dashboard é carregado sob demanda e relatórios usam polling para refletir alterações sem WebSocket.

## Testes

O backend possui testes unitários para ambiente, tenant guard, auditoria, rate limit, uso, segmentos, masking, segurança de autenticação, estatística, webhooks, integridade de auditoria e retenção. Não há suíte frontend identificada. A contagem exata deve ser obtida pelo comando `cd backend && npm test`, não inferida a partir de documentos históricos.

## Fluxos críticos

### Importação

Google Sheets ou CSV -> rota de importação -> `importService` -> validação -> deduplicação -> cálculo de uso -> `Client` e `Movement` -> `ImportJob` e notificações de qualidade.

### Campanha

Segmento/filtros -> preview da audiência -> exclusão de opt-outs e dedupe -> `MessageEvent` com status `FILA` -> dispatch em lote e throttle -> adaptador WhatsApp/SMS -> webhooks de entrega/leitura/resposta -> relatório e atribuição de conversão.

### Automação

Scheduler/cron -> `automationEngine` -> regra ativa e gatilho -> ação de campanha, notificação ou bloqueio -> proteção de dedupe existente.

## Limitações e roadmap

O recorte atual não inclui fila externa, WebSocket, API pública, inbox conversacional, observabilidade completa, testes de carga, KMS/HSM real ou infraestrutura de longa duração. O plano Hobby da Vercel limita cron a uma execução diária, então a UI oferece ações manuais para dispatch, refresh e sincronização.

## Decisões observadas

1. PostgreSQL é usado como fila inicial para reduzir infraestrutura e preservar uma interface de domínio migrável.
2. A divisão segura evita classificar limite ausente ou zero como uso normal.
3. Adaptadores de canal isolam provedores e permitem failover de SMS.
4. O frontend chama `/api` por proxy/rewrite, evitando acoplamento à URL interna do backend.
5. A documentação pública deve usar placeholders para ambiente e nunca reproduzir segredos ou dados pessoais.

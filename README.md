# CRM TopConta

CRM inteligente que transforma uma planilha Google Sheets em fonte de inteligência
comercial: importa e sincroniza bases de clientes, calcula automaticamente perfis
e percentuais de uso, gera segmentações acionáveis e executa campanhas por
WhatsApp (Cloud API) e SMS — com histórico auditável e controles de conformidade
com a LGPD.

Este repositório contém o **MVP da Fase 1** do PRD (ver seção "Escopo desta
entrega" abaixo).

## Stack

- **Backend**: Node.js + TypeScript, Express, Prisma ORM, PostgreSQL, JWT, `node-cron`.
- **Frontend**: React + TypeScript + Vite, React Router.
- **Integrações**: Google Sheets API (Service Account), WhatsApp Cloud API, SMS
  (adaptador genérico com implementação de referência para Twilio).

## Estrutura do repositório

```
backend/            API REST (Express) + regras de negócio + Prisma
  prisma/schema.prisma   Modelo de dados (Tenant, Client, Campaign, ...)
  prisma/seed.ts         Massa de dados de demonstração
  src/services/          Lógica de negócio (cálculo de uso, dedupe, LGPD, canais, fila)
  src/routes/             Endpoints REST
frontend/            SPA (React) — dashboard, base de clientes, campanhas, etc.
docker-compose.yml   PostgreSQL local para desenvolvimento
```

## Como rodar localmente

### 1. Banco de dados

```bash
docker compose up -d
```

### 2. Backend

```bash
cd backend
cp .env.example .env      # ajuste DATABASE_URL/credenciais conforme necessário
npm install
npx prisma migrate dev --name init
npm run prisma:seed       # cria tenant + usuários + clientes de demonstração
npm run dev                # API em http://localhost:4000
```

Usuário de demonstração criado pelo seed: `admin@topconta.demo` / `mudar123`
(também `operador@topconta.demo` e `analista@topconta.demo`, mesma senha).

### 3. Frontend

```bash
cd frontend
npm install
npm run dev                # SPA em http://localhost:5173 (proxy para /api → :4000)
```

### Testes

```bash
cd backend
npm test                   # regras de negócio: cálculo de percentual/faixa, LGPD (masking/hash/CPF)
```

## Escopo desta entrega (Fase 1 — MVP)

Implementado, mapeando os itens **Must have** do PRD:

- **Google Sheets**: conector via Service Account (`src/services/googleSheets.ts`),
  mapeamento de colunas configurável, sincronização agendada via cron por tenant
  (`src/services/scheduler.ts`) e trigger manual (`POST /api/imports/google-sheets`).
  Fallback de importação via CSV/linhas já parseadas (`POST /api/imports/csv`).
- **Validação e deduplicação**: todos os 14 campos mínimos do PRD, checksum de CPF,
  normalização de telefone (E.164), dedupe por CPF (hash) com fallback por telefone,
  regra de fusão "última atualização ganha" preservando o histórico
  (`src/services/importService.ts`, `src/services/dedupe.ts`).
- **Histórico de importação**: `ImportJob` com contadores de linhas adicionadas/
  atualizadas/erro e motivo de cada erro.
- **Cálculo de percentual e faixas de uso**: divisão segura (limite zero/ausente
  não gera erro nem falsa faixa) e as 7 faixas do PRD, mutuamente exclusivas e
  determinísticas (`src/services/usage.ts`, com testes unitários).
- **Dashboard**: métricas do PRD (total, novos, ativos/inativos, faixas, ranking
  de cidades, limite/valor/saldo agregados, ticket médio, % no limite, sem uso,
  última atualização) em `GET /api/dashboard/summary`.
- **Perfil do cliente**: dados cadastrais, limites/percentual, histórico de
  movimentações e de mensagens/campanhas recebidas.
- **Wizard de campanhas**: seleção de canal, segmentação (segmento salvo ou
  filtros ad-hoc), preview de público (já excluindo opt-outs), mensagem com
  placeholders, agendamento, throttle (msgs/min) e janela de dedupe configurável
  por campanha.
- **Canais**: abstração `ChannelAdapter` com implementação real para WhatsApp
  Cloud API e SMS (Twilio como referência), mais adaptadores mock para
  desenvolvimento sem credenciais/custo.
- **Fila de envio**: enfileiramento do público elegível respeitando dedupe,
  processamento em lotes respeitando o throttle, webhooks de status
  (entregue/lido/respondido/falha) com idempotência.
- **Relatórios de campanha**: público, status por envio, conversões com janela
  de atribuição configurável (default 7 dias), custo total, taxa de conversão.
- **Automação básica**: modelo de `AutomationRule` com os 5 gatilhos do PRD
  (ativação de cliente novo, reativação 30 dias, aviso de limite renovado,
  estímulo por faixa, bloqueio em opt-out/telefone inválido) — CRUD e
  ativação/desativação prontos; a avaliação automática dos gatilhos por evento
  fica descrita como próximo passo (ver Roadmap).
- **Segurança/LGPD**: CPF nunca armazenado em texto plano (hash HMAC com salt
  por tenant + versão mascarada), opt-out sticky (uma vez recusado, importação
  não reativa autorização sozinha), controle de acesso por papel (Admin,
  Operador, Analista, Visualizador), log de auditoria em todas as ações
  sensíveis, isolamento de dados por tenant em todas as queries.
- **Auth**: login com JWT, roles, tela de auditoria restrita a Admin/Analista.

### Não incluído nesta entrega (roadmap explícito no PRD)

Ver seção "Fase 2" e "Fase 3" do PRD original: segment builder avançado com
combinação AND/OR visual, correção em massa de erros de importação, gerenciador
de templates com aprovação WhatsApp, A/B testing, motor de recomendações,
conversational inbox, conectores de BI, KMS/HSM para chaves, filas reais
(RabbitMQ/Redis) em substituição à fila modelada em Postgres, testes de carga e
observabilidade (Prometheus/ELK). O código já isola essas peças atrás de
interfaces (`ChannelAdapter`, fila em `campaignQueue.ts`) para facilitar a
evolução sem reescrita.

## Decisões técnicas relevantes

- **Fila de mensagens em Postgres, não em RabbitMQ/Redis**: para o MVP, o
  `MessageEvent` com `status=FILA` cumpre o papel de fila, processado em lotes
  via `POST /api/campaigns/:id/dispatch` (chamado por um worker/cron externo).
  A interface de domínio (`enqueueCampaign`/`processQueueBatch`) foi desenhada
  para migrar para uma fila real sem alterar as regras de negócio.
- **Percentual de uso com divisão segura**: `limite_total <= 0` retorna
  percentual 0 e faixa `INDEFINIDO` (em vez de erro ou falso "não utilizou"),
  conforme a regra de negócio do PRD.
- **CPF**: nunca é persistido em texto plano — apenas hash HMAC-SHA256 com salt
  por tenant (para dedupe) e uma versão mascarada para exibição.

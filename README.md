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
# gere a chave de cifra das credenciais de canal (WhatsApp/SMS) e cole em CREDENTIALS_ENCRYPTION_KEY:
openssl rand -base64 32
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

## Deploy em produção (Vercel + Supabase)

Arquitetura em produção: **dois projetos Vercel** (backend serverless + frontend
estático) e **Postgres no Supabase**, cada um cuidando de uma responsabilidade:

```
Navegador → crmtopconta-frontend.vercel.app (Vite estático)
              └─ vercel.json rewrite: /api/* → crmtopconta-backend (Vercel)
                   └─ Express (api/index.ts, função serverless) → Prisma → Supabase Postgres
Vercel Cron Jobs → /api/cron/* (dispatch, automações, sync de planilha, retenção...)
```

- **backend/**: deployado como projeto Vercel próprio (Root Directory = `backend`),
  usando `backend/vercel.json` (`builds`/`routes` explícitos — necessário porque a
  detecção automática de framework da Vercel confunde este projeto com um app
  Express "tradicional" e tenta um build estático inexistente). Os jobs periódicos
  do MVP local (`node-cron`, em `src/services/scheduler.ts`) viram **Vercel Cron
  Jobs** batendo nos endpoints `/api/cron/*` (protegidos por `CRON_SECRET`), já
  que uma função serverless não mantém um processo vivo entre invocações.
- **frontend/**: deployado como projeto Vercel próprio (Root Directory = `frontend`),
  com `frontend/vercel.json` fazendo um *rewrite* de `/api/*` para o domínio do
  projeto backend — assim o código do frontend continua chamando `/api/...`
  (mesma origem, sem CORS), sem precisar saber a URL real do backend.
- **Supabase**: hospeda o Postgres. O schema é aplicado via SQL gerado a partir do
  Prisma (`prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script`)
  e executado diretamente no projeto Supabase — não é necessário rodar
  `prisma migrate deploy` a partir de um ambiente com acesso à rede do banco.

### ⚠️ Limitação do plano Hobby (gratuito) da Vercel: cron só 1x/dia

O plano Hobby só permite cron jobs com frequência mínima de 1x/dia. Os jobs que no
MVP local rodam a cada 1/5/30 minutos (disparo de fila de campanha, motor de
automação, refresh de segmentos dinâmicos) em produção no Hobby rodam **1x por
dia**, em horários espalhados (ver `backend/vercel.json`). Enquanto estiver nesse
plano, use os botões manuais já disponíveis na UI para execução sob demanda:
"Disparar lote" (campanhas), "Atualizar agora" (segmentos), "Sincronizar agora"
(planilha). Upgrade para o plano Pro remove essa limitação e permite restaurar a
cadência original editando `backend/vercel.json`.

### Variáveis de ambiente a configurar no projeto Vercel do backend

Em *Project Settings → Environment Variables* do projeto `crmtopconta-backend`:

| Variável | De onde vem |
|---|---|
| `DATABASE_URL` | Supabase → Project Settings → Database → Connection string → modo **Transaction** (porta 6543, pooler) |
| `DIRECT_URL` | Supabase → Project Settings → Database → Connection string → conexão **direta** (porta 5432) |
| `JWT_SECRET` | gere com `openssl rand -base64 32` |
| `CREDENTIALS_ENCRYPTION_KEY` | gere com `openssl rand -base64 32` |
| `CRON_SECRET` | gere com `openssl rand -base64 32` — a Vercel envia esse valor automaticamente como `Authorization: Bearer` nas chamadas dos Cron Jobs quando a env var se chama exatamente `CRON_SECRET` |
| `GOOGLE_SERVICE_ACCOUNT_JSON`, `WHATSAPP_*`, `TWILIO_*` | opcionais — só necessários para sincronização real de planilha e envio real de mensagens |

Depois de configurar as variáveis, é preciso disparar um novo deploy para que a
função serverless passe a enxergá-las (variáveis adicionadas depois de um deploy
já criado não retroagem automaticamente).

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
  ativação/desativação prontos. **Avaliação automática implementada na Fase 2**
  (ver abaixo).
- **Segurança/LGPD**: CPF nunca armazenado em texto plano (hash HMAC com salt
  por tenant + versão mascarada), opt-out sticky (uma vez recusado, importação
  não reativa autorização sozinha), controle de acesso por papel (Admin,
  Operador, Analista, Visualizador), log de auditoria em todas as ações
  sensíveis, isolamento de dados por tenant em todas as queries.
- **Auth**: login com JWT, roles, tela de auditoria restrita a Admin/Analista.

## Escopo da Fase 2 (Robustez e Automação)

Implementado, mapeando os itens **Should have** do PRD:

- **Importação — qualidade e correção**: `GET /api/imports/quality` (registros
  incompletos, motivos de erro mais recorrentes nos últimos 30 dias),
  `POST /api/imports/:id/fix-errors` (reenvia só as linhas corrigidas pelo
  mesmo pipeline de validação/dedupe) e notificações in-app quando uma
  sincronização falha total ou parcialmente (`src/services/notifications.ts`).
- **Segment builder avançado**: `buildSegmentWhere` agora aceita tanto o
  formato simples (Fase 1) quanto grupos `{ operator: 'AND'|'OR', conditions,
  groups[] }` combináveis recursivamente (`src/services/segments.ts`, com
  testes unitários). Segmentos podem ser marcados `dynamic` e têm um
  `refreshCron` próprio, recontados automaticamente pelo scheduler.
- **Motor de automação real**: `src/services/automationEngine.ts` avalia as
  `AutomationRule` ativas a cada 5 minutos, casando clientes por gatilho
  (novo sem uso, inativo há N dias, limite renovado — detectado via `Movement`
  criado no import quando `limiteTotal` aumenta —, faixa de uso, inconsistência
  de opt-out) e executando a ação configurada: criar+disparar campanha,
  notificar, ou bloquear diretamente. Reenvios ao mesmo cliente continuam
  protegidos pela janela de dedupe existente (mesmo texto de mensagem entre
  disparos automáticos).
- **Templates com aprovação e preview**: `MessageTemplate` com `status`
  (rascunho/pendente/aprovado/rejeitado — WhatsApp nasce pendente, SMS nasce
  aprovado), reaprovação automática ao editar o corpo de um template já
  aprovado, e endpoint de preview rico com placeholders substituídos.
  Campanhas podem referenciar um `templateId` aprovado em vez de texto livre.
- **Rate limiting + failover multi-provider (SMS)**: `Tenant.maxMsgsPerMinute`
  limita o total de envios/minuto do tenant somando todas as campanhas
  (`GET/PUT /api/tenant/settings`); `ChannelConfig.priority` permite cadastrar
  múltiplos provedores do mesmo canal (ex.: Twilio + Zenvia para SMS) com
  fallback automático quando o provedor de maior prioridade falha no envio.
- **Relatórios avançados**: atribuição de conversão agora também soma o valor
  da movimentação convertida (`convertedValue`), permitindo calcular ROI por
  campanha; export CSV do relatório de campanha e da base de clientes,
  restrito por papel (Admin/Operador/Analista).
- **Sandbox de campanhas + A/B testing básico**: `POST /api/campaigns/:id/test-send`
  envia a variante A para uma amostra de até 10 telefones sem tocar no público
  real; campanhas podem ter `messageTemplateB` + `variantSplitPercent`, com o
  público sorteado entre variante A/B no enfileiramento e o relatório
  quebrado por variante.
- **Segurança avançada**: credenciais de canal (`ChannelConfig.credentials`)
  são cifradas em repouso com AES-256-GCM via envelope encryption
  (`src/services/crypto.ts`, chave mestra simulando uma KMS externa — troca
  direta por AWS/GCP/Azure KMS sem alterar o restante do fluxo); job diário de
  retenção/anonimização (`src/services/retention.ts`) implementa o
  right-to-be-forgotten da LGPD para clientes sem atividade além da política
  do tenant (`Tenant.retentionDays`).

## Escopo da Fase 3 (recorte leve, compatível com a infra atual)

A Fase 3 do PRD (Inteligência e Escala) foi desenhada para 6-9 meses e
pressupõe infraestrutura incompatível com o deploy atual (Vercel serverless +
Supabase): Kubernetes, RabbitMQ, Elastic Stack, HSM, "milhões de mensagens/mês".
Em vez de trocar de arquitetura, foi implementado um recorte que entrega valor
real da Fase 3 sem sair do que já está no ar:

- **A/B testing com significância estatística**: `src/services/statistics.ts`
  implementa um teste de duas proporções (two-proportion z-test, sem
  dependências externas — função erro aproximada por Abramowitz & Stegun) que
  calcula p-valor e decide significância a 95% entre as variantes A/B de uma
  campanha, com testes unitários. Exibido no relatório da campanha; amostras
  abaixo de 30 envios por variante são sinalizadas como "dado insuficiente"
  em vez de uma conclusão precipitada.
- **Conector BI leve (Google Sheets em vez de BigQuery/Data Studio)**:
  `src/services/biExport.ts` escreve diariamente (cron) — ou sob demanda,
  botão "Exportar resumo (BI)" em Integrações — um snapshot dos KPIs do
  dashboard e das últimas campanhas na aba `CRM_Export` da mesma planilha
  usada para importação. Serve como fonte de dados para Google Data
  Studio/Looker Studio sem precisar provisionar BigQuery.
- **Atualizações quase em tempo real via polling**: sem WebSocket/streaming,
  o Dashboard e o relatório de campanha (enquanto ainda há envios em fila) se
  atualizam sozinhos a cada 20-30s.

### Não incluído (roadmap explícito no PRD — Fase 3 completa)

Motor de recomendações (ML) para segmentos e horário de envio, A/B testing com
análise estatística mais sofisticada (ex.: testes sequenciais, correção para
múltiplas comparações), conversational inbox, conectores de BI nativos
(BigQuery/Data Studio), API pública, multi-tenant avançado com SLAs, filas
reais (RabbitMQ/Redis/Kafka) em substituição à fila modelada em Postgres,
eventos em tempo real via WebSocket (hoje via polling), observabilidade
(Prometheus/ELK/Jaeger), testes de carga e chaos engineering, KMS/HSM real
(hoje simulado por uma chave de aplicação). Migrar para esses itens
implicaria trocar a hospedagem serverless atual por uma com processos de
longa duração (Railway/Render/Kubernetes). O código já isola as peças mais
prováveis de evoluir atrás de interfaces (`ChannelAdapter`, fila em
`campaignQueue.ts`, `crypto.ts`) para facilitar essa migração sem reescrita.

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

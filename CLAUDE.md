# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CRM TopConta: turns a Google Sheets client base into a commercial-intelligence
source — imports/syncs client data, computes usage percentages/tiers, builds
segments, and runs WhatsApp (Cloud API) / SMS campaigns, with LGPD compliance
controls (CPF never stored in plaintext, opt-out enforcement, audit log,
tenant isolation).

Two independent npm packages, no workspace tooling tying them together:
`backend/` (Express + TypeScript + Prisma) and `frontend/` (React + TypeScript
+ Vite). Run npm commands from inside each directory.

## Commands

### Backend (`cd backend`)

```bash
docker compose up -d              # Postgres local (run from repo root)
npm install
npx prisma migrate dev --name x   # apply/create a migration
npm run prisma:generate           # regenerate Prisma client after schema changes
npm run prisma:seed               # tenant + demo users + demo clients
npm run dev                       # ts-node-dev, API on :4000
npm run build                     # tsc -p tsconfig.json
npm test                          # jest --runInBand, all *.test.ts under src/
npx jest src/services/usage.test.ts   # run a single test file
```

Demo users from seed: `admin@topconta.demo` / `operador@topconta.demo` /
`analista@topconta.demo`, password `mudar123`.

### Frontend (`cd frontend`)

```bash
npm install
npm run dev        # Vite dev server on :5173, proxies /api → :4000
npm run build       # tsc -b && vite build
```

## Architecture

### Request flow / entry points

`backend/src/app.ts` builds the Express app (middleware, all `/api/*` route
mounts) but does **not** call `app.listen()` or start the scheduler — it's
imported by two different entry points:

- `backend/src/index.ts` — local long-running server, also starts
  `services/scheduler.ts` (node-cron) if `ENABLE_SCHEDULER=true`.
- `backend/api/index.ts` — Vercel serverless handler; just re-exports `app`.
  No in-process scheduler here (see Cron section below).

### Tenant isolation & auth

Every table hangs off `Tenant`. `middleware/auth.ts` verifies the JWT and
attaches `req.user.tenantId`; every Prisma query in services/routes must
filter by that tenantId — there is no other isolation boundary. Roles are
`ADMIN | OPERATOR | ANALYST | VIEWER`, enforced via `requireRole(...)`.

Login can involve a two-step flow: password check issues either a normal JWT
or, if the user has 2FA enabled, a short-lived `pending2FA` token (5 min,
only valid against `POST /api/auth/2fa/verify`, rejected by `requireAuth`).

### Import pipeline

`services/googleSheets.ts` (Service Account) or `POST /api/imports/csv` feed
rows into `services/importService.ts`, which validates the PRD's required
fields, dedupes via `services/dedupe.ts` (CPF hash first, phone fallback),
and applies "last update wins" while preserving history via `Movement`
records. `services/cardAccountImport.ts` handles the real-world "Cartões e
contas" spreadsheet format (sourced from the `SaldoCartao` tab) as an
alternative input shape feeding the same pipeline. Usage percentage/tier
(`services/usage.ts`) uses safe division — a zero/missing `limite_total`
yields tier `INDEFINIDO`, never an error or false "no usage".

The card transaction statement is the source of *real* usage, since `Client`
only holds the latest snapshot (which swings with the payroll cycle: the
invoice is deducted from payroll and the limit renews). It lives in `Purchase`
(see "Comércio credenciado" below); `services/transactionClassifier.ts` decides
what counts as usage from `Purchase.tipo`: `Débito Pix Cartão` = salary advance
(`Juros` is profit), `Compra à Vista` = purchase at partner stores (no profit
data) — subscription (`Assinatura`, fixed monthly fee), invoice debit and any
unknown description never count.

The "Cartões e contas" import also records `AccountSnapshot` rows
(`services/accountSnapshot.ts`): a change log of saldo/limite/status, written
only when one of them changes or on a client's first sighting — not a daily
dump of the whole base. State on date D = latest row with `recordedAt <= D`;
`saldoAnterior` gives the delta (the limit "returns" after payroll payment, so
`limiteTotal` often stays flat while `saldoDisponivel` jumps — the existing
`LIMITE_RENOVADO` automation only looks at `limiteTotal`). Failures never break
the import.

### LGPD / security primitives

- CPF: never persisted in plaintext — HMAC-SHA256 hash with a per-tenant salt
  (`Tenant.cpfSalt`) for dedupe, plus a masked display version
  (`services/masking.ts`).
- Channel credentials (`ChannelConfig.credentials`) are encrypted at rest via
  envelope encryption (`services/crypto.ts`, AES-256-GCM with an app-level
  master key standing in for a real KMS — swappable for AWS/GCP/Azure KMS
  without touching callers).
- Opt-out is sticky: once a client opts out, re-import never silently
  re-authorizes them.
- `services/retention.ts` runs a daily right-to-be-forgotten job anonymizing
  clients inactive past `Tenant.retentionDays`.
- Every sensitive action goes through `middleware/audit.ts` into `AuditLog`.

### Campaign send path

`services/campaignQueue.ts` enqueues the eligible audience as `MessageEvent`
rows with `status=FILA` (Postgres *is* the queue — no
RabbitMQ/Redis/Kafka), respecting the per-campaign dedupe window and the
tenant-wide `maxMsgsPerMinute` throttle. `POST /api/campaigns/:id/dispatch`
processes a batch. Channels are abstracted behind `ChannelAdapter`
(`services/channels/types.ts`), with real implementations for WhatsApp Cloud
API and SMS (Twilio as the reference provider, `ChannelConfig.priority`
enables multi-provider failover) plus mock adapters for credential-free dev.


Campaign results are measured by *real usage*, not limit renewals
(`services/campaignResults.ts`, computed on request from `Purchase` — no
stored attribution state, so late-imported usage shows up on its own): a
conversion is an antecipação or compra after the send (subscription never
counts), reported as a cumulative D0/D1/D3/D7/D14/D30 curve in Brasília
calendar days. If a client got several campaigns, usage is credited to the
most recent one. Clients are split by balance at send time (`AccountSnapshot`
as-of lookup; `MIN_SALDO_ELEGIVEL`) into com saldo / sem saldo / desconhecido
(no history yet). Optional control group: `Campaign.controlGroupPercent` leaves
that share of the audience unmessaged as `MessageStatus.CONTROLE`; since the
send is spread over days, each control client is assigned the timestamp of a
real send (matched by quantile) so both windows start alike, and the report
shows lift (two-proportion z-test) and incremental profit. Profit is only
`Juros` of antecipações — compra à vista profit (merchant fee) is unknown, so
it's excluded from profit/ROI rather than counted as zero.
### Automation engine

`services/automationEngine.ts` evaluates active `AutomationRule`s on a timer,
matching clients against the PRD's 5 triggers (new client, 30-day
reactivation, limit renewed — detected via a `Movement` created on import
when `limiteTotal` increases —, usage-tier nudges, opt-out/invalid-phone
block) and firing the configured action (launch campaign, notify, or block).
Repeat sends to the same client stay protected by the existing dedupe window.

### Dashboard e histórico

`routes/dashboard.ts` expõe `GET /api/dashboard/overview` (KPIs, variação vs. período anterior,
séries, nota de saúde, funil, oportunidades, resultado de campanhas, cobertura de dados e insights;
filtros `days`, `cidade`, `empresaConveniada`) e `GET /api/dashboard/audiencia` (ids do público de
uma oportunidade, para "Criar campanha"). Tendência e variação vêm de `DashboardSnapshot`: uma foto
diária dos KPIs por tenant (`services/snapshots.ts`), gravada pelo job `/api/cron/snapshot` e,
como garantia no plano Hobby, na primeira visita do dia ao dashboard. O histórico começa no dia em
que a tabela foi criada e não é reconstruível. Com filtro de cidade/convênio, séries e variações
ficam indisponíveis (a foto é da base inteira). A nota de saúde (`services/health.ts`) tem pesos e
metas fixos e é testada em `health.test.ts`. O SQL da tabela está em `backend/prisma/sql/`.

### Campanha manual (lista de planilha)

Tela `/campaigns/manual` (botão "Campanha por planilha"): sobe `.xlsx`/`.csv` (lido no navegador com `read-excel-file`, linhas vão em JSON, até 5000) com nome,
telefone, CPF (opcional) e limite disponível (opcional). `services/manualCampaign.ts`: `parseManualRows` (telefone E.164, CPF/CNPJ com zero perdido recomposto e só
em hash, limite por `parseMoney`), `matchManualAudience` (liga ao `Client` por CPF, senão telefone com variações do 9º dígito; exclui opt-out, conta bloqueada,
sem limite e quem pediu PARAR numa lista anterior) e `linkRecipients` (refaz o vínculo depois de novas importações). `POST /api/campaigns/manual/preview` e
`POST /api/campaigns/manual` (exige `consentimento: true`, template WhatsApp `APROVADO`) criam `Campaign.manual=true`, os `CampaignRecipient` (ficam guardados para
análise) e os `MessageEvent` em FILA; o disparo é o mesmo ("Disparar lote"/cron) e só sai por template aprovado pela Meta. `MessageEvent.clientId` agora é opcional
(`recipientId` aponta o destinatário); a mensagem usa nome e limite da planilha (`recipientContext`) e o envio aparece na Inbox mesmo sem cliente. O limite da
planilha **nunca** altera `Client.saldoDisponivel`. Variável nova `{{limite_disponivel}}` (= `{{saldo}}` nas campanhas tradicionais; na manual vem da planilha;
linha sem valor é recusada/bloqueada se o texto a usa). Resultado: o relatório normal mede os contatos ligados a cliente; `GET /api/campaigns/:id/destinatarios`
traz, por contato, se usou e em quantos dias (`diasAteUso`). Contatos fora da base passam a ser medidos quando entrarem na base. Retenção anonimiza destinatários.
SQL: `backend/prisma/sql/2026-10-campanha-manual.sql` (rodar antes do deploy).

### Assistente de campanhas (4 passos), templates da Meta e custo

`/campaigns/new` (`pages/campaigns/CampaignWizard.tsx`, o antigo virou `/campaigns/classic`, para SMS/texto livre/A-B): Configuração (nome, template com Recentes/Recomendados/busca,
preview do WhatsApp com imagem) → Público (Todos / Segmentos / **Planilha** / Teste, e "Lista pré-selecionada" vinda do Dashboard/Comércio) → Validação → Agendamento
(Imediato ou data/hora, rascunho). `POST /api/campaigns/wizard/validar` (`services/campaignWizard.ts`, só lê) devolve conferências ok/aviso/erro (template aprovado e mapeado,
imagem, Meta conectada, público, dedupe, extrato velho, custo, agendamento). Lançar = criar (`POST /campaigns` ou `/campaigns/manual`) → `/schedule` (enfileira; para lista
manual `enqueueManualCampaign`) → no "Imediato" o navegador chama `/dispatch` em lotes de 25 com barra de progresso (a tela precisa ficar aberta; o resto sai no ciclo diário).
"Agendar": grava `scheduledAt` e `runCampaignDispatchJob` só pega campanha vencida; no plano Hobby o cron roda 1x/dia (~06h Brasília), então não sai na hora marcada.
**Templates importados da Meta:** `POST /api/templates/sync` agora IMPORTA os que só existem na Meta (`origin=META`, `services/templateImport.ts`, puro): `metaBody` com
{{1}},{{2}}, `variableMap` (qual variável nossa preenche cada posição; palpite pelo exemplo, a pessoa confirma no passo 1/Templates via `PATCH variableMap`), `buttons`, `sendIssue`
(cabeçalho de vídeo/documento, botão com link variável, variável nomeada, autenticação: não enviamos). Não envia com variável sem mapa. Excluir um importado NÃO apaga na Meta;
o texto dele só muda na Meta. **Cabeçalho com imagem:** `TemplateMedia` (JPG/PNG até 3 MB), `PUT/DELETE/GET /api/templates/:id/header`; no envio a imagem sobe para a Meta uma vez
por lote (`prepareHeaderImage` → `uploadHeaderImage`, id usado como `header` do template); para criar template nosso com imagem a Meta exige exemplo por upload resumível
(`uploadTemplateExample`, precisa de `WhatsAppAccount.appId`, campo opcional em Integrações) — fluxo escrito pela documentação, ainda não testado contra a Meta. Imagem de importado:
tenta baixar o exemplo do cabeçalho na importação, senão envie uma em Templates. **Custo:** `services/messageCost.ts` (US$ por categoria × câmbio; padrão marketing R$ 0,41 =
0,0822 × 4,99; utilidade sem padrão), configurável em `GET/PUT /api/campaigns/custos` (ADMIN) e gravado em `Campaign.costPerMessage`. SQL: `backend/prisma/sql/2026-10-assistente-campanha.sql`
(rodar antes do deploy, depois de `2026-10-campanha-manual.sql`).

### Templates: lista, editor em 3 passos e botões (fase 1)

`/templates` (lista com filtros de categoria/status, busca, pré-visualizar, usar em campanha) e `/templates/new|:id/edit` (`pages/TemplateEditor.tsx`: Configuração → Conteúdo →
Botões, com preview em WhatsApp; template SMS fica num formulário simples na lista). Botões (`whatsappTemplates.ts`): resposta rápida (`quickReplies`, até 10), **Visitar site**
(`buttons` tipo URL, até 2, `https://`, link fixo sem variável) e **Ligar** (`PHONE_NUMBER`, até 1, vira +DDI), até 10 no total, textos únicos de até 25 caracteres; no payload da
Meta as respostas rápidas vêm antes dos botões de ação. `validateTemplate` valida tudo no servidor; criar/editar/enviar usam `buttons`/`language` em `routes/templates.ts` (mudar
botões de um template já enviado gera nova versão). Link rastreado por cliente: ver abaixo (fase 2); copiar código e cabeçalho de
vídeo/documento, a fase 3. Importados da Meta continuam só leitura (texto muda na Meta).

### Link rastreado nos botões de template (fase 2)

Botão "Visitar site" com **Rastrear cliques** (`CtaButton.tracked`, padrão ligado no editor): a Meta aprova `https://<LINK_BASE_URL>/r/{{1}}` (exemplo com código de mentira) e o DESTINO REAL fica
só em `MessageTemplate.buttons[].url`, editável sem nova aprovação (`buttonsSignature` em `routes/templates.ts` ignora o destino ao decidir se é nova versão). `services/trackedLinks.ts`:
código de 45 caracteres = tipo (`e` mensagem de campanha / `n` teste e Inbox) + id (32 hex) + índice do botão + assinatura HMAC (chave derivada de `JWT_SECRET`); `trackedButtons` calcula o índice
como a Meta conta (respostas rápidas antes dos botões de ação). No envio (`processQueueBatch`, `sendTemplateMessage`) o código entra como `button`/`sub_type: url` do template.
`GET /r/:token` (`routes/trackedLinks.ts`, **público**, 120/min por IP, cross-tenant de propósito) valida a assinatura, acha o destino pelo template, soma `MessageEvent.clickCount` e grava
`clickedAt` no 1º clique, e redireciona (302). Não é redirecionador aberto (destino só do template cadastrado); código inválido vai para `LINK_FALLBACK_URL` (https) ou dá 404. Prévia de link
do WhatsApp, HEAD e robôs (`isBotUserAgent`) redirecionam sem contar. Relatório: `cliques` em `GET /campaigns/:id/report` (clicaram, taxa, dias até o clique, uso do limite de quem clicou x quem não),
"Clicou?" em `/destinatarios` e `clicou_em`/`cliques` no CSV. Env: `LINK_BASE_URL` (domínio dos links; padrão `PUBLIC_BACKEND_URL` ou o da Vercel — o domínio vai dentro do template aprovado, então
mudá-lo exige nova versão do template) e `LINK_FALLBACK_URL`. SQL: `backend/prisma/sql/2026-10-link-rastreado.sql` (rodar antes do deploy). Ainda não testado contra a Meta (aprovação de template com
link dinâmico é decisão deles).

### Fila de oportunidades e campanhas por categoria

`services/opportunities.ts` calcula a fila do dashboard (`GET /api/dashboard/oportunidades`): faixas
de uso do limite (cortes 50/70/80%), ativação, comércio (supermercado sem posto, 1 compra, 3+ compras,
top 10% em valor), relacionamento, qualidade de dados (status `dados`: não é campanha) e itens que
dependem de histórico (`historico`). `GET /api/dashboard/audiencia?tipo=` devolve os ids do público e a
mensagem sugerida; o assistente de campanha recebe tudo via router state (`presetClientIds`,
`presetMessage`, `presetChannel`). Em /commerce, `GET /api/purchases/audiencia` aceita `minCompras`
(frequência mínima) e devolve o público por frequência e a mensagem da categoria. Mensagens sugeridas só
podem usar as variáveis de `services/templateVariables.ts` (`nome`, `cidade`, `percentual`, `saldo`,
`limite`, `limite_disponivel`), que o envio de fato preenche; `opportunities.test.ts` garante isso.

### Perfil de renda PF1–PF4

`services/rendaPerfil.ts` estima o salário pelo **limite total** (limite ÷ 0,40; nunca o saldo disponível) e
classifica em PF1 (até R$ 4.000, inclui quem estaria abaixo do piso), PF2 (até 8.000), PF3 (até 12.000) e PF4
(acima). Cálculo puro, sem coluna nova: `limiteRange` vira o filtro `perfilRenda` em `SegmentFilters` (e no
assistente de campanha). O limite tem teto de R$ 2.000 (`noTetoLimite`), por isso PF3/PF4 aparecem quase vazios.
**Limite zero/vazio = comércio credenciado**: `ENVIAVEL_WHERE` o exclui de todo público de campanha e o envio
bloqueia o evento por garantia. `POST /api/segments/presets/perfis-renda` cria/atualiza os segmentos prontos
(`PERFIL_RENDA_PRESETS`) e `GET /api/dashboard/perfis-renda` alimenta o card do dashboard.

### Etapa de uso real (recorrência e dias sem uso)

`services/etapaUso.ts` classifica cada cliente pelo **extrato** (`Purchase`, só antecipação e compra à vista) em
NUNCA_USOU / RECORRENTE (3+ usos em 90 dias e uso nos últimos 30) / OCASIONAL / EM_RISCO (31–90 dias) / INATIVO
(+90). Três colunas em `Client` (`ultimoUsoReal`, `usosUltimos90d`, `usosTotal`) são refeitas por
`services/usageRefresh.ts` após cada importação de compras e no job diário de snapshot (a janela de 90 dias anda
sozinha). Filtros: `etapaUso`, `usosMin/usosMax`, `diasSemUsoRealMin/Max` (diferentes de `dataUltimaUtilizacao`,
que também recebe a data de ativação da planilha de contas). "Nunca usou" vale para o período coberto pelo
extrato. SQL em `backend/prisma/sql/2026-10-uso-real-cliente.sql` (rodar antes do deploy). Presets:
`POST /api/segments/presets/etapas-uso`.

### Relatório por perfil, frescor do extrato e automação por etapa

`services/campaignPerfil.ts` quebra o resultado da campanha por PF1–PF4 (limite atual do cliente; controle comparado
dentro do mesmo perfil) — `porPerfil` em `GET /api/campaigns/:id/report`. `services/dataFreshness.ts` avalia se o
extrato de compras está em dia (limite 3 dias; `GET /api/dashboard/frescor`, aviso no dashboard e no assistente).
O gatilho de automação `ETAPA_PERFIL` (condição `etapaUso`, `perfilRenda`, `comSaldo`) dispara por etapa/perfil e
**não roda com extrato velho** ou ausente.

### Nota de saúde por uso real

`services/health.ts` tem duas notas. Com extrato de compras em dia (`dataFreshness.ts`), vale a **nota por uso real**
(`computeRealHealth`, dados em `healthData.ts`): alcance 25 (meta 60% já usaram), uso recente 30 (meta 30% nos
últimos 30 dias), recorrência 20 (meta 15%), retenção 15 (dos que usaram, % ainda ativos em 90 dias) e
regularidade 10, só com clientes com limite. Sem extrato ou com extrato parado, cai na nota estimada pelo saldo e o
dashboard avisa (`saude.modelo`/`saude.aviso`). `DashboardSnapshot.healthScore` guarda a nota real diária (SQL em
`backend/prisma/sql/2026-10-health-score-real.sql`); a tendência e a variação só usam dias com nota real.

### Inbox do WhatsApp (Meta Cloud API) — Fase 1

Mensagens RECEBIDAS chegam em `POST /api/integrations/webhooks/whatsapp` (campo `messages` da Meta). O handler
só grava mensagens com `WHATSAPP_APP_SECRET` configurado e assinatura `X-Hub-Signature-256` válida. O tenant sai do
`phone_number_id` (`WhatsAppAccount`, único no banco; consulta cross-tenant de propósito) e o resto roda no contexto
do tenant. `services/whatsappPayload.ts` (puro: parsing, variações do 9º dígito BR, detecção de opt-out "PARAR/SAIR",
janela de 24h) e `services/whatsappInbox.ts` (grava `Conversation` + `WaMessage`, idempotente pelo `wamid`, liga ao
cliente pelo telefone, marca a `MessageEvent` da campanha como RESPONDIDO e registra opt-out + auditoria).
`routes/inbox.ts`: `/status`, `PUT /account` (ADMIN), `/conversations`, `/conversations/:id/messages`, `/read`;
telefones sempre mascarados. Tela `/inbox` (leitura, atualização por polling de 5s). A janela de 24h conta de
`Conversation.lastInboundAt`. **Fase 2 (mídia):** `services/whatsappMedia.ts` busca o arquivo na Graph API em 2 passos (`GET /{media-id}` → URL temporária → bytes, com `WHATSAPP_ACCESS_TOKEN`) e guarda a cópia em `WaMediaBlob` (limite de 4 MB: a Vercel não devolve respostas maiores; o webhook já guarda ao receber e a tela tenta de novo se falhar). `GET /api/inbox/media/:messageId` serve o arquivo autenticado (só tipos seguros abrem inline, resto baixa; `nosniff` + CSP restritiva); o front busca com o token e mostra por URL local (imagem com zoom, áudio/vídeo com player, PDF abre/baixa). SQL: `backend/prisma/sql/2026-10-whatsapp-media.sql`. **Fase 3 (responder):** `POST /api/inbox/conversations/:id/messages` (ADMIN/OPERATOR) envia texto ou arquivo (base64 no JSON, até 3 MB; imagem JPG/PNG, PDF, áudio OGG/MP3/M4A/AAC/AMR, vídeo MP4) via `services/whatsappReply.ts` + `whatsappSend.ts`: confere a janela de 24h (`409 JANELA_FECHADA` fora dela), envia pela Meta (upload em `/{phone-number-id}/media` + `/messages`) e só então grava a `WaMessage` de saída (`sentByUserId`, status `sent`); a Meta recusando, nada é gravado. O webhook `statuses` atualiza o status (sent→delivered→read, nunca volta; failed guarda o motivo traduzido). SQL: `backend/prisma/sql/2026-10-whatsapp-reply.sql`. Fora da janela só template (Fase 4): hoje
`WhatsAppCloudAdapter` só envia texto livre, que a Meta recusa fora da janela. SQL: `backend/prisma/sql/2026-10-whatsapp-inbox.sql`
(inclui RLS e GRANT; rodar antes do deploy). Webhook e token da Meta: ver o roteiro da Fase 0.

### Inbox: resposta automática, aviso de mensagem nova e tela cheia

**Resposta automática** (`services/whatsappAutoReply.ts`): o número é canal só de avisos; quem escreve recebe `AUTO_REPLY_PADRAO` (manda ao suporte (79) 99837-2540) ou o texto
da conta (`WhatsAppAccount.autoReplyText`, nulo = padrão; `autoReplyEnabled`, ligada por padrão). O webhook chama `maybeAutoReply` depois de `storeInboundMessage`: responde a TODA mensagem NOVA do cliente (reenvio da Meta não conta), nunca a opt-out (PARAR/SAIR), mas no máximo
`AUTO_REPLY_MAX` (3) vezes por conversa em 24 h corridas (conta os `WaMessage` SAIDA `automatic=true` da janela; sem coluna de controle; envio recusado pela Meta não grava, então não conta). Vai como texto livre dentro da janela de 24h que a mensagem do cliente acabou de abrir; grava `WaMessage.automatic=true` (a tela mostra "🤖 Resposta
automática") e não zera o não lido. Nunca lança (o webhook não pode falhar por isso). `GET/PUT /api/inbox/auto-reply` (PUT só ADMIN, auditado) alimenta o painel "Resposta automática"
na Inbox. **Aviso de mensagem nova:** `GET /api/inbox/resumo` (leve: não lidas + última) é consultado a cada 15 s por `components/InboxAlerts.tsx` em QUALQUER tela: balão no canto
(some em 9 s, abre a conversa), bipe, "(N)" no título da aba e, com a aba em segundo plano, notificação do navegador (botão "Ativar avisos no navegador" na Inbox pede a permissão). A
primeira consulta só marca o que já existia. A Inbox usa a tela toda (`.main:has(.inbox-page)`). SQL: `backend/prisma/sql/2026-10-whatsapp-resposta-automatica.sql` (rodar antes do deploy; `Conversation.lastAutoReplyAt` da 1ª versão ficou no banco sem uso).

### Ligações pelo WhatsApp (Calling API da Meta) — passo 0: diagnóstico

Decisão: o cliente liga PARA nós pelo WhatsApp (ligação recebida, sem pedir permissão; a empresa ligar exige permissão por template, 2.000 destinatários/dia e tem limites por cliente). Requisitos
da Meta (documentação oficial): número na Cloud API, assinar o campo `calls` do webhook, `whatsapp_business_messaging`, limite diário de **2.000 destinatários únicos** e ligar o recurso nas "call
settings" do número (vem desligado). Mídia por WebRTC (ICE+DTLS+SRTP) ou SIP; áudio Opus, e G.711 (PCMA/PCMU) desde março/2026 — PCMU é o que a ponte da xAI já usa. Isso exige um servidor SEMPRE
LIGADO fora da Vercel (ainda não existe). Passo 0 já feito: `services/whatsappCalling.ts` (puro, testado) lê `messaging_limit_tier` e `GET /{phone}/settings → calling.status` e o "Testar conexão" do
modal da Meta devolve `ligacoes` (informativo: não muda o resultado do teste). Próximos passos: ligar o recurso no número, assinar `calls`, tratar o webhook (SDP offer → accept com SDP answer),
servidor de áudio ↔ xAI e registro das ligações.

### RETOMAR DEPOIS: ligação pelo WhatsApp (cliente liga para a IA) e outras pendências

**Estado em 18/10/2026.** Decisão: o cliente liga PARA nós pelo WhatsApp (Calling API da Meta); ligação da empresa para o cliente fica de fora (exige permissão por template). Já feito e em produção: só o
diagnóstico no "Testar conexão" (passo 0 acima). Conferido na Meta: limite diário = **10.000** (atende o mínimo de 2.000; o campo `messaging_limit_tier` NÃO vem pela Graph API para esse número, então o
diagnóstico mostra ❔ no limite: aceitável, ou trocar a leitura); recurso de ligações **desligado de propósito** (ligar antes do servidor de áudio pronto faria o ícone aparecer e as chamadas tocarem
sem atender, o que derruba a taxa de atendimento e gera restrição da Meta). **Vercel não serve para o áudio** (WebRTC usa UDP; função da Vercel só atende HTTP/WebSocket).
Hospedagem escolhida em princípio: **Fly.io** (aceita UDP, região gru; só o áudio vai para lá, o resto do CRM continua na Vercel); o usuário ainda precisa criar a conta (cartão) e dizer "pode seguir
com o Fly.io". Alternativas: VPS (Docker), ou serviço gerenciado (LiveKit Cloud).
Passos que faltam, em ordem: (1) servidor de áudio em pacote separado (Node + WebRTC, ex. `werift`, codec **PCMU** para repassar direto à xAI sem converter; reaproveitar `services/voice.ts` e
`voiceBridge.ts`); (2) tratar o webhook `calls` (o `POST /api/integrations/webhooks/whatsapp` da Vercel recebe o SDP offer, repassa ao servidor de áudio com segredo compartilhado, devolve o SDP answer e
chama `accept` na Graph API; `terminate` ao fim); (3) assinar o campo `calls` no app da Meta e ligar `calling.status=ENABLED` no número (`POST /{phone}/settings`) e escolher o codec PCMU nas call settings;
(4) tabela de ligações (cliente, duração, resultado, custo) + tela/relatório; (5) template com botão de ligar (call button) e ajuste do texto da resposta automática da Inbox (hoje diz "não realizamos
atendimentos por aqui"); (6) testar com um celular de teste antes de abrir a todos. Limites a respeitar: baixa taxa de atendimento e reclamações geram restrição; ligação da empresa: 1 pedido de permissão/dia e
2/semana por cliente. Não dá para testar contra a Meta fora do ambiente real (sandbox só para Tech Partners).

**Outras pendências em aberto:** Twilio — concluir o Trust Hub (Primary Customer Profile) para ligações de SAÍDA; teste de ligação RECEBIDA ainda não reportado (número do Twilio precisa estar na conta e
"A call comes in" = `https://crmtopconta-backend.vercel.app/api/voice/inbound`). Inbox — opcional: avisar na tela quando a assinatura do webhook for inválida. Cidades — opcional: incluir "assessoria/
consultoria/tecnologia/comunicacao" na regex de nome de empresa de `cidades.ts`; 90 clientes ativos com limite sem cidade válida. Dados — enviar extrato de setembro de Natal (06/09–05/10) e Carmópolis
(07/09–06/10) para medir o ciclo anterior; reimportar a base de 790 clientes com limite 0; 15 clientes lixo; `LINK_BASE_URL` com domínio próprio; templates fase 3 (copiar código, cabeçalho de
vídeo/documento); limpeza de sobras do Supabase. Dashboard — oferecer botão "Criar campanha" por cidade para quem não usou o saldo.

### Templates do WhatsApp (Meta) — Fase 4

`services/whatsappTemplates.ts` (validação das regras da Meta, nosso `{{nome}}` → `{{1}}`, payload com exemplos, Graph API de criar/listar/excluir
e `sendTemplateMessage`) + `whatsappTemplateSync.ts` (status por webhook `message_template_status_update`/`_quality_update`/`template_category_update`
e `POST /api/templates/sync`). `MessageTemplate` ganhou `category` (MARKETING|UTILITY), `footer`, `quickReplies`, `version`, `metaName`
(`{slug}_v{version}`), `metaStatus`, `qualityScore`. Fluxo: criar (RASCUNHO) → `POST /api/templates/:id/submit` (precisa de `WhatsAppAccount.wabaId`
+ `WHATSAPP_ACCESS_TOKEN`) → status da Meta; editar um template já enviado gera nova versão. Só é enviável o template com `status=APROVADO` **e**
`metaStatus=APPROVED` (`isSendableTemplate`); a aprovação manual existe só sem a Meta conectada (dev). **Campanhas:** com provedor WhatsApp real,
`processQueueBatch` só envia template aprovado (`resolveWhatsAppTemplate`; senão devolve `bloqueado` e não mexe na fila); com mock mantém texto livre;
A/B não existe com template da Meta; o texto enviado aparece na conversa da inbox (`recordOutboundTemplateMessage`). **Inbox:** `GET/POST
/api/inbox/conversations/:id/template(s)` envia template fora da janela de 24h (cliente em opt-out é bloqueado); o toque num botão "SAIR" também
descadastra. SQL: `backend/prisma/sql/2026-10-whatsapp-templates.sql`.

### Conexão com a Meta pela tela de Integrações

As credenciais do WhatsApp NÃO ficam mais em variáveis da Vercel: a tela **Integrações → WhatsApp (Meta Cloud API)** (`WhatsAppConfigModal`) grava
em `WhatsAppAccount` o Phone Number ID, o WABA ID e, **cifrados** (`services/whatsappAccount.ts` + `crypto.ts`, `CREDENTIALS_ENCRYPTION_KEY`), o
Access Token e o App Secret (a tela só recebe os 4 últimos caracteres). O token de verificação do webhook é gerado pelo sistema (`verifyToken`, único)
e mostrado para colar na Meta. Rotas (`routes/integrations.ts`, ADMIN para escrever): `GET/PUT/DELETE /api/integrations/whatsapp`, `POST .../test`
(valida número e WABA na Graph API e guarda o resultado) e `POST .../subscribe` (`/{WABA}/subscribed_apps`). O webhook acha a conta pelo
`phone_number_id`/WABA ID do corpo e valida `X-Hub-Signature-256` com o App Secret DAQUELA conta (sem segredo, mensagens/status/templates são
ignorados); o desafio GET aceita o `verifyToken` de qualquer conta. Todos os consumidores (campanha, inbox, mídia, templates) leem o token por
`credentialsOf(account)`; as variáveis `WHATSAPP_*` só valem como reserva. SQL: `backend/prisma/sql/2026-10-whatsapp-credentials.sql`.

### Comércio credenciado (compras por categoria)

A aba "Todas as Compras" da planilha (transações do cartão) entra por `POST /api/purchases/import`
(`services/purchaseImport.ts`, formato "Compras" na tela de Importações; CSV exportado da aba). Cada linha
liga ao cliente pelo hash do CPF/CNPJ (zero à esquerda perdido pela planilha é recomposto); transação
de cliente que ainda não está na base é ignorada e reaparece ao reenviar o arquivo (idempotente por
`idTransacaoCartao`). Só "Compra à Vista..." tem lojista (`Merchant`); saque/Pix/assinatura entram sem
lojista e alimentam `Client.dataUltimaUtilizacao`. A planilha não traz categoria: ela é deduzida do nome
do lojista (`services/merchantCategories.ts`) e é editável em /commerce (`categorySource=MANUAL` nunca é
sobrescrito). Os valores desta aba vêm no formato dos EUA (`R$ 1,591.00`), por isso `parseMoney` deduz o
separador decimal. Segmentos e campanhas filtram por `categoriasCompra`/`lojistaIds`/`compraNosUltimosDias`
(`services/segments.ts`). **Filtro por cidade em /commerce:** o cliente só usa o cartão no comércio da própria cidade, então vale a cidade do CLIENTE
(`Client.cidade`); nome de empresa/vazio na coluna vira "Sem cidade" (`services/cidades.ts`, regra espelhada em SQL por `cidadeKeySql`). Os endpoints
`/purchases/categories|merchants|audiencia` aceitam `cidades` (chaves separadas por `|`) e `GET /purchases/cidades` lista as opções.

**SQL cru e RLS:** `prisma.$queryRaw*` não passa pelo hook de tenant e, sob o role `app_runtime`, não
enxerga nenhuma linha. Use sempre `tenantRaw.query/execute` (`config/db.ts`), que abre a transaction com
`app.tenant_id`.

### Proteção da importação (formato, não zerar, impacto, desfazer)

Nasceu de um incidente: um CSV de compras importado como "Cartões e contas" zerou limite/saldo/status de ~2.900 clientes. Camadas:
(1) `services/importFormat.ts` (e cópia em `frontend/src/utils/importFormat.ts`, pacotes independentes) reconhece o formato pelos cabeçalhos; a tela bloqueia
e oferece "Usar o formato X", e o servidor devolve `422 FORMATO_INCOMPATIVEL` (ADMIN pode `forcarFormato`) com base nos `cabecalhos` enviados.
(2) **Coluna ausente nunca zera**: `FieldPresence` (limite/saldo/utilizado/status) é calculada sobre o ARQUIVO INTEIRO na tela (`camposPresentes`) e `planUpdate`
(cartões) / `PROTEGIDOS` (genérico) tiram esses campos do update; célula vazia em coluna que TEM dados continua valendo zero (comércio credenciado).
(3) `POST /imports/cartoes/preview` simula sem gravar (novos, atualizados, limites alterados/zerados, status, autorização revogada, campos ignorados); a tela soma os
lotes e exige confirmação extra se zera ≥20 clientes ou ≥2%. (4) Desfazer: cada import de clientes grava `ImportChange` (estado anterior das colunas tocadas, ou CRIADO),
guardado 30 dias; `POST /imports/lotes/:loteId/desfazer` (ADMIN, só a ÚLTIMA importação de clientes, em partes de 300 até `concluido`; a tela repete) restaura, apaga criados e
seus snapshots/movimentos. Compras não têm preview nem desfazer. (5) `ImportJob.formato/loteId/nomeArquivo`: o arquivo (vários jobs de 400 linhas) é um `loteId`; o histórico
vem de `GET /imports/lotes` (`groupLotes`). SQL: `backend/prisma/sql/2026-10-protecao-importacao.sql` (rodar antes do deploy). O servidor confia nos cabeçalhos enviados pela tela.

### Ciclo de cobrança por cidade (fase 1)

Cada cidade tem um dia de **abertura** do ciclo, quando o limite renova (fechamento = dia anterior; fatura descontada em folha). Dados do extrato confirmam: o uso dispara na abertura
e decai nos dias seguintes. `CicloCidade` (por tenant, `cidadeKey` = `cidades.ts`) guarda o cadastro; `services/ciclos.ts` é o cálculo puro em dias civis de Brasília (`cicloInfo`: dias desde a
abertura, dias para abrir, dia do ciclo; mês curto usa o último dia). A abertura da cidade fica em `Client.diaCicloAbertura`, refeita por `services/cicloRefresh.ts` (ao salvar o cadastro, ao fim
de cada importação de clientes e no job diário de snapshot) — assim os filtros seguem síncronos: `cicloAbriuHaDias {min,max}` e `cicloAbreEmDias {min,max}` viram `diaCicloAbertura in [...]`
(`diasAberturaNaFaixa`); cidade sem ciclo não entra em nenhum. `routes/ciclos.ts`: `GET /api/ciclos` (cadastro + cidades da base sem ciclo), `PUT /api/ciclos` (ADMIN, tabela inteira),
`GET /api/ciclos/proximos` (card do Dashboard: abriu há ≤2 dias ou abre em ≤7), `GET /api/ciclos/audiencia?cidadeKey=` (ids aptos + mensagem para "Criar campanha"). Telas: `/ciclos`
(preenche a tabela da TopConta: Natal 6, Carmópolis 7, Itaporanga e N. S. da Glória 10, Lagarto/Itabaianinha/Boquim/Luziânia 15), card no Dashboard e seção em Segmentos. **Fase 2:** gatilho de automação `CICLO_ABERTO` (`automationEngine.ts`): casa quem tem `diaCicloAbertura` igual ao de uma cidade que abriu há `diasAposAbertura` dias
(default 0 = no dia), opcionalmente só `cidades` escolhidas (chaves de `CicloCidade`), `perfilRenda`, `etapaUso` (exige extrato em dia) e `comSaldo` (o saldo vem da última planilha, pode não
refletir a renovação). `matchClients` devolve **um grupo por cidade** e `runRule` executa a ação por grupo: uma campanha por cidade (`Automação: <regra> · <cidade> (<data>)`, resultado separado e
sem repetir no mesmo dia). `POST /api/automations/:id/run` (`simular: true` só conta por cidade) alimenta "Simular"/"Rodar agora" na tela. Limite do plano Hobby: o motor roda 1x/dia (~07h BRT) e a
ação de campanha envia só `throttlePerMin` (default 60) mensagens por execução; o resto depende do "Disparar lote"/cron de disparo — para públicos grandes (Natal) o caminho mais completo é o botão
"Criar campanha" do card (o navegador drena em lotes). **Fase 3** (`services/cicloReport.ts`, puro e testado): (a) `GET /api/ciclos/uso-por-dia?dias=90` — curva de uso (antecipação + compra à vista do extrato) por dia do ciclo, por cidade e no
total, normalizada em "usos por 100 clientes por dia observado" (o extrato cobre período parcial; o período termina no último dia do extrato, não em hoje). Diagnóstico da data cadastrada:
pico nos dias 1–3 = ok, pico depois = "revisar data" (ou o limite renova mais tarde), <30 usos = poucos dados. Componente `UsoPorDiaCiclo` na tela `/ciclos`. (b) `porCiclo` em
`GET /api/campaigns/:id/report` — resultado e lift pelo dia do ciclo da cidade do cliente no momento do envio (faixas 1–3, 4–7, 8–15, 16+, sem ciclo), card "Resultado por dia do ciclo no
envio". Não usa `AccountSnapshot` para validar a abertura (hoje só há uma foto; quando houver histórico dá para checar o salto do saldo). SQL: `backend/prisma/sql/2026-10-ciclos-cidade.sql` (rodar antes do deploy).

### Filtro por datas e "Uso no período" no dashboard

`GET /api/dashboard/overview` aceita `de`/`ate` (YYYY-MM-DD, Brasília) no lugar de `days`: a janela passa a ser a das datas para a série (fotos `DashboardSnapshot`), a linha de base da variação, campanhas e novos clientes
(os KPIs seguem sendo "de agora"; `periodo.personalizado`). `GET /api/dashboard/uso-periodo` (`services/usoPeriodo.ts`, puro: `resolvePeriodo`, `periodoAnterior`, `preencheDias`, `variacaoPct`) mede o uso REAL pelo extrato
(`Purchase`, antecipação e compra à vista, mesmo critério de `USO_TIPO_SQL`): clientes que usaram, usos, valor, juros das antecipações, uso por dia e cidades que mais usaram, com variação contra o período anterior de mesma duração,
e `extrato.cobrePeriodo` avisa quando o extrato termina antes do fim do período. Aceita cidade/convênio. Tela: campos De/Até no cabeçalho do Dashboard (sobrepõem os botões 7/30/90 dias; "Limpar datas" volta) e o card
`UsoPeriodoCard`. **Adesão da base ativa ao saldo** (`adesao` e `cidades[]` em `uso-periodo`; `services/usoPeriodo.ts`: `taxaAdesao`, `faixaAdesao`, `faltamParaMeta`): meta da TopConta = **80% da base ATIVA** (conta `ATIVO` e `limiteTotal > 0`)
usando o saldo; taxa = clientes dessa base que usaram no período (antecipação ou compra à vista, distintos) ÷ base ativa, no geral e por cidade (cidade sem uso entra com 0%), com "faltam N clientes para a meta" e variação em p.p. contra o período
anterior (mesma base de hoje nos dois). Faixas: ≥80% meta atingida, 60–79,9% atenção, abaixo fora da meta. Nos dados de 10/09–09/10: Luziânia 86,4%, Itaporanga 79,8% (falta 1), Natal 43,1%, Lagarto 45,3% (cidade vem de `cidadeKeySql`; nomes de empresa
sem a palavra-chave da regra, como "ASSESSORIA", ainda aparecem como cidade). **Adesão por ciclo** (`GET /api/dashboard/adesao-ciclo`, card `AdesaoCicloCard`): uma janela fixa de 30 dias corta o ciclo de cada cidade num ponto diferente (Luziânia foi de 86% para 76% só por isso), então a comparação justa para a meta de 80% é por
ciclo: para cada cidade de `CicloCidade`, `janelasDoCiclo` (`cicloReport.ts`) dá o último ciclo COMPLETO (abertura anterior → dia antes da última abertura) e o ciclo em andamento (parcial); mede clientes ativos com limite que usaram em cada um, `faltam` para 80%,
e `coberto`/`semDados` quando o extrato não cobre a janela (ex.: Natal e Carmópolis não têm compras de setembro no extrato: ciclo anterior ≈ 0% com ciclo atual alto = falta de dado, não de uso). O geral do ciclo completo soma só cidades com dados.
`.main:has(.pd)` libera a largura do dashboard (antes limitada a 1440px, o que deixava faixa vazia à direita em monitor largo).

### Ligação com IA de voz (xAI + Twilio) — fase 1: teste

O CRM manda o Twilio ligar (`POST /api/voice/test-call`, ADMIN, `routes/voice.ts`); ao atender, o Twilio abre um WebSocket (Media Streams) com a **ponte** `backend/api/voice-bridge.ts` (função própria da Vercel, só importa código
puro), que abre outro WebSocket com o agente de voz da xAI (`wss://api.x.ai/v1/realtime?agent_id=…` ou `?model=grok-voice-latest`) e repassa o áudio nos dois sentidos em G.711 μ-law 8 kHz (`audio/pcmu`, sem conversão).
`services/voice.ts` (puro): token HMAC da ligação (contexto nome/saldo, expira em 10 min; o endpoint da ponte é público, então só confia no token), `buildTwiml`, `buildInstructions` (português; só diz o saldo depois de
confirmar quem atende; nunca pede CPF/senha), `buildSessionUpdate` e as funções `registrar_resultado`/`encerrar_ligacao`. `services/voiceBridge.ts`: máquina de estados da ponte, sem rede e testada (`voiceBridge.test.ts`): agente fala
primeiro, `speech_started` manda `clear` ao Twilio, aviso de despedida 12 s antes do limite (`VOICE_MAX_SECONDS`, padrão 90), fechar o WebSocket do Twilio encerra a ligação, logs `[voice] …` (latência do primeiro áudio, duração,
resultado; transcrição só com `VOICE_LOG_TRANSCRIPT=1`). Webhook de status público `POST /api/voice/twilio-status` (assinatura X-Twilio-Signature). Fase 1 liga SÓ para `VOICE_TEST_NUMBER` (nunca número da tela), 3 por hora. Teste por ligação RECEBIDA: `POST /api/voice/inbound` (público, assinatura Twilio; configurar em "A call comes in" do número) só atende quando o `From` é o `VOICE_TEST_NUMBER` (senão `<Reject/>`, sem custo); usa `VOICE_TEST_NAME`/`VOICE_TEST_SALDO` (padrão Maria/250). Dispensa a verificação da empresa exigida pelo Twilio para ligações de saída.
Env (backend): `XAI_API_KEY`, `XAI_AGENT_ID` (opcional), `XAI_VOICE_MODEL`, `XAI_VOICE`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VOICE_NUMBER` (ou `TWILIO_FROM_NUMBER`), `VOICE_TEST_NUMBER`, `PUBLIC_BACKEND_URL`.
`backend/vercel.json` ganhou build/rota própria da ponte antes do catch-all. **Ainda não verificado:** se a Vercel mantém o WebSocket com essa configuração `builds`/`routes` e por quanto tempo (limite de duração da função), a qualidade do
português, a latência e o custo por minuto — o teste da fase 1 serve para isso. Protocolo da xAI conferido no código do Pipecat (`pipecat/services/xai/realtime`), não na documentação oficial. Próximas fases: campanha de voz (canal VOZ, fila,
janela de horário), ações (link por WhatsApp, opt-out) e resultado no relatório.

### Cron jobs: local vs. Vercel

Locally, `services/scheduler.ts` runs everything via `node-cron` in-process.
In production (serverless, no long-running process), the same jobs are
exposed as HTTP endpoints under `/api/cron/*` (`routes/cron.ts`, protected by
`CRON_SECRET` bearer auth) and triggered by Vercel Cron Jobs
(`backend/vercel.json`).

**Vercel Hobby plan caps cron at once/day.** Jobs that run every 1-30 min
locally (campaign dispatch, automation engine, dynamic segment refresh) are
squashed to once/day at staggered times in `backend/vercel.json` on that
plan — the UI has manual "run now" buttons ("Disparar lote", "Atualizar
agora", "Sincronizar agora") to compensate. Upgrading to Pro removes the cap;
restore the original cadence by editing `backend/vercel.json`.

### Deployment topology

Two separate Vercel projects (root directories `backend` and `frontend`) plus
Supabase Postgres:

```
Browser → frontend (Vite static) → vercel.json rewrite /api/* → backend project
             backend: api/index.ts (serverless fn) → Prisma → Supabase Postgres
Vercel Cron Jobs → backend /api/cron/*
```

- `backend/vercel.json` uses explicit `builds`/`routes` (not framework
  auto-detect, which misidentifies this as a static-build Express app).
- `frontend/vercel.json` rewrites `/api/*` to the backend project's domain so
  the frontend always calls same-origin `/api/...` (no CORS, no hardcoded
  backend URL in frontend code).
- Prisma's `binaryTargets` includes `rhel-openssl-3.0.x` for Vercel's Lambda
  runtime, alongside `native` for local dev.
- Schema changes reach Supabase via
  `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script`
  run directly against the Supabase project — not `prisma migrate deploy`
  (no network path from a normal dev/CI environment to the DB for that).
- `DATABASE_URL` must be the Supabase pooler connection (port 6543,
  Transaction mode) at runtime; `DIRECT_URL` (port 5432, direct) is only for
  `prisma migrate`/`db push`, never at request time.
- New/changed env vars on Vercel require a fresh deploy to take effect.

### Testing

Backend unit tests (`npx jest`) cover business rules that are easy to get
subtly wrong: usage tier boundaries (`usage.test.ts`), segment filter
combination logic (`segments.test.ts`), CPF/phone masking and hashing
(`masking.test.ts`), login rate-limiting/lockout (`authSecurity.test.ts`),
and the A/B significance z-test (`statistics.test.ts`). No frontend test
suite exists yet.

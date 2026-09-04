# Achados — por severidade

Status possíveis: **Corrigido** (código alterado + teste automatizado prova),
**Risco aceito** (avaliado, decisão consciente de não corrigir agora),
**Roadmap** (decisão consciente de corrigir depois, com plano registrado).

## Crítico

### 1. `JWT_SECRET` com fallback silencioso para valor padrão + sem validação de boot
**Status: Corrigido**

`backend/src/middleware/auth.ts` caía para `"dev-secret-change-me"` se `JWT_SECRET`
não estivesse setado — se isso ocorresse em produção, qualquer pessoa poderia forjar
um token JWT válido (inclusive de ADMIN) sabendo esse valor público. Nenhum secret
obrigatório (`JWT_SECRET`, `CREDENTIALS_ENCRYPTION_KEY`, `DATABASE_URL`) era validado
no boot — falhas só apareceriam tarde, de forma obscura, na primeira requisição que
precisasse deles.

**Verificação no ambiente real**: `vercel env ls production`/`preview` confirmou
`JWT_SECRET`/`DATABASE_URL` corretos, mas revelou que a variável de criptografia
estava salva em produção com o nome digitado errado —
**`REDENTIALS_ENCRYPTION_KEY`** em vez de `CREDENTIALS_ENCRYPTION_KEY` — ou seja, a
chave que o código sempre esperou nunca existiu de fato em produção. Corrigido nesta
sessão (chave nova gerada, nome certo, nos dois ambientes) com aprovação explícita
do usuário — ver `infra-snapshot.md` para o antes/depois completo.

Correção: `backend/src/config/env.ts` (novo) valida os 3 secrets obrigatórios com
zod, no import, lançando erro imediato e explícito se algum faltar — importado como
primeira linha relevante de `backend/src/app.ts`, então roda em qualquer entry point
(local ou serverless). Fallback removido de `auth.ts`.

### 2. Webhooks públicos sem verificação de assinatura
**Status: Corrigido**

`POST /webhooks/whatsapp` e `POST /webhooks/sms/:provider`
(`backend/src/routes/integrations.ts`) aceitavam qualquer payload — um `webhookSecret`
já era gerado e salvo por `ChannelConfig` mas nunca lido em lugar nenhum; um
comentário no código afirmava falsamente que havia validação. Qualquer pessoa podia
forjar status de entrega ou opt-out de mensagens.

Correção: `backend/src/services/webhookAuth.ts` (novo) implementa verificação de
`X-Twilio-Signature` (HMAC-SHA1, usa `TWILIO_AUTH_TOKEN` já existente) e
`X-Hub-Signature-256` (HMAC-SHA256, usa o novo `WHATSAPP_APP_SECRET` — **secret novo,
ainda não provisionado em produção**, ver nota abaixo), com `crypto.timingSafeEqual`.
Twilio: rejeita com 401 se assinatura ausente/inválida. WhatsApp: se
`WHATSAPP_APP_SECRET` não estiver configurado, aceita a requisição mas emite
`console.warn` em toda chamada até o secret ser provisionado — comportamento
defensivo intencional, documentado, não um bug.

**Ação pendente**: provisionar `WHATSAPP_APP_SECRET` (Meta App Dashboard → Settings →
Basic) nas env vars do Vercel para fechar completamente a lacuna do WhatsApp — até lá,
o endpoint do WhatsApp continua aceitando requisições não verificadas (com warning nos
logs), o do Twilio já está 100% protegido.

## Alto

### 3. CORS totalmente aberto
**Status: Corrigido**

`app.use(cors())` sem opções aceitava qualquer origem. Corrigido para uma allow-list
via novo env var `ALLOWED_ORIGINS` (`backend/src/app.ts`, `backend/.env.example`) —
default seguro (`http://localhost:5173`, com warning) se não configurado. Setada em
produção nesta sessão (`https://crmtopconta-frontend.vercel.app`), confirmado via
`vercel env ls` — ver `infra-snapshot.md`.

### 4. Nenhum header de segurança HTTP
**Status: Corrigido**

Sem `helmet`, sem CSP/HSTS/X-Frame-Options/nosniff, `X-Powered-By` exposto. Corrigido
com `helmet()` (config padrão — API só-JSON, sem HTML, não precisa de CSP customizada).

### 5. Sem rate limiting além do login
**Status: Corrigido**

`/api/auth/2fa/verify`, os webhooks públicos e as rotas de import não tinham
throttle. Corrigido com `express-rate-limit`: 2FA (10/15min por IP), webhooks
(100/min por IP), imports (20/10min por usuário, nas 4 rotas que rodam o pipeline
caro de import). Limitação documentada: o store em memória do `express-rate-limit` é
por instância — em serverless (Vercel), cada cold start reresetа o contador; aceitável
porque o bloqueio de login (a superfície de maior risco) já é DB-backed e consistente
entre invocações.

### 6. RLS decorativo — isolamento de tenant só em código, sem rede de segurança no banco
**Status: Corrigido (rede de segurança em código) + Roadmap (RLS real)**

Confirmado via `get_advisors` do Supabase (RLS ligado, zero policies em 14 tabelas) e
SQL direto (`rolbypassrls = true` no role `postgres` usado pelo `DATABASE_URL`). Uma
única query esquecendo `tenantId` seria um vazamento silencioso entre tenants, sem
nenhuma rede de segurança no banco.

Decisão do usuário (pergunta direta antes da implementação): fazer os dois, em fases
— rede de segurança em código agora, RLS real depois.

Correção aplicada agora: `backend/src/config/tenantGuard.ts` (novo) — extensão do
Prisma Client que lança erro (não warning) se `findMany`/`findFirst`/
`findFirstOrThrow`/`count`/`aggregate`/`groupBy`/`updateMany`/`deleteMany` num modelo
com `tenantId` rodar sem esse filtro no `where` (checando recursivamente dentro de
`AND`/`OR`/`NOT`, cobrindo os filtros dinâmicos de `services/segments.ts`). `create`/
`createMany` verificam `tenantId` em `data`. Escape hatch (`withCrossTenantAccess`,
via `AsyncLocalStorage`) usado nos 4 pontos legitimamente cross-tenant (jobs de
scheduler/cron). Achado real capturado no processo: uma `client.updateMany` na ação
de bloqueio do motor de automação não tinha `tenantId` no `where` — corrigida.

Limitação documentada e intencional: `findUnique`/`update`/`delete`/`upsert`
continuam sem o guard (são operações por id único — o risco residual ali é IDOR de
registro único, não vazamento de tabela inteira; o app já segue o padrão
verify-then-act — `findFirst` com `tenantId` antes de `update`/`delete` por id — na
maioria das rotas). Ver item de roadmap abaixo.

**Atualização (rodada de finalização) — RLS real: implementado, aplicado no Supabase,
ativação em produção pendente de aprovação.**

Role `app_runtime` (`NOBYPASSRLS`) + policy `tenant_isolation` (`FOR ALL`,
`current_setting('app.tenant_id', true)`) em todas as 14 tabelas — aplicado ao Supabase de
produção via SQL rodado pelo usuário, confirmado via `get_advisors(type=security)` (os 14
lints `rls_enabled_no_policy` zeraram). `backend/src/config/tenantGuard.ts` ganhou um segundo
`AsyncLocalStorage` (`requestTenantContext`, setado por `middleware/auth.ts` logo após o JWT) e
a extensão do Prisma passou a envolver TODA operação — não só as guardadas — numa transaction
que primeiro roda `set_config('app.tenant_id', ...)`. Os 4 pontos cross-tenant de sempre
(scheduler/automationEngine) continuam usando `withCrossTenantAccess`, mas agora despacham para
um client administrativo separado (`prismaAdmin`, role privilegiado, sem RLS) em vez de só
pular o check de código — e o trabalho por-tenant que vem depois de cada varredura cross-tenant
(scheduler.ts, automationEngine.ts, retention.ts, biExport.ts) passou a rodar dentro do
contexto de tenant real via `runWithTenantContextAsync`. `prisma/seed.ts` e o login/2FA (que
precisam de lookup por email/id antes de saber o tenant) usam o mesmo desvio administrativo.

Validado nesta sessão contra Postgres real local (não só mocks): login, CRUD normal, os 6 jobs
de cron/scheduler, e um teste explícito de isolamento — um segundo tenant criado só para o
teste viu 0 clientes via a API HTTP, enquanto o tenant original continuou vendo os seus
normalmente. Suíte completa (98 testes) e `tsc --noEmit` passando.

**Status final: ativo em produção (2026-09-04).** `DATABASE_URL` de produção trocada para
`app_runtime` e `DATABASE_URL_ADMIN` adicionada (role privilegiado, só para os jobs
cross-tenant do scheduler) — deploy do código correspondente confirmado `READY`, zero erros de
runtime pós-deploy, dados intactos (1 tenant, 1 user, 370 clients, inalterados), e login real
feito pelo usuário na aplicação em produção confirmando que o caminho restrito por RLS
(`app_runtime`) funciona ponta a ponta para tráfego real. RLS deixou de ser decorativo — é a
segunda camada de defesa em produção agora, não só em código.

Nota operacional: a senha do role `postgres` (privilegiado) foi trocada pelo usuário no meio
desta rodada (rotação de uma credencial fraca encontrada por acaso) — `DATABASE_URL_ADMIN` e
`DIRECT_URL` já foram atualizadas com o valor novo antes do deploy, sem incidente.

Auditoria de IDOR nas rotas de update/delete por id (item antes listado como decorrência deste
roadmap) foi feita separadamente nesta mesma rodada — ver achado #12 abaixo.

### 7. Vazamento de erro cru para o cliente HTTP
**Status: Corrigido**

`backend/src/routes/imports.ts` devolvia `e.message` (erro cru do Prisma/Google
Sheets API) direto na resposta HTTP em vez da mensagem genérica do handler global.
Corrigido — mensagem genérica na resposta, detalhe completo só em log de servidor
(o registro salvo em `Notification`/`ImportJob` para o admin do tenant ver depois foi
mantido, é uso legítimo diferente). `backend/src/routes/tenant.ts` também corrigido —
`findUniqueOrThrow` (gerava um 500 cru em P2025) trocado por `findUnique` + 404
explícito.

## Médio

### 8. Anonimização (LGPD) não alcançava PII em `AuditLog`
**Status: Corrigido**

`services/retention.ts` anonimizava o `Client`, mas `AuditLog.details` mantinha PII
crua indefinidamente: `req.body` inteiro em `UPDATE_USER`/`UPDATE_AUTOMATION`,
telefones crus em `TEST_SEND_CAMPAIGN`, campos livres em `UPDATE_CLIENT`.

Correção em duas partes: (A) todos os `logAudit(...)` que passavam PII crua agora
logam só o que mudou/contagens (ex.: `{ fieldsChanged: [...] }`,
`{ phoneCount: N }`) — auditoria continua registrando *o que aconteceu* sem duplicar
o valor da PII indefinidamente. (B) `retention.ts` agora também redige, no momento da
anonimização de um cliente, os `AuditLog` existentes endereçáveis por
`target="Client" + targetId` daquele cliente.

Limitação documentada: a cascata só alcança entradas endereçáveis por `targetId` —
entradas antigas que citavam PII por valor (não por id, ex.: telefones crus já
gravados antes desta correção) não são retroativamente redigidas; a parte (A) evita
que isso volte a acontecer daqui pra frente.

### 9. Vulnerabilidades moderadas de dependências
**Status: ver `infra-snapshot.md` para o resultado final do `npm audit` pós-bump**

`uuid` <11.1.1 (backend, via `googleapis`/`node-cron`) e `react-router`/
`react-router-dom` <7.18.0 (frontend) — sem críticas/altas, mas com fix disponível
via bump de major version. Tratado no último lote de correções.

### 10. Frontend sem gate de rota em `/users` (e `/audit`)
**Status: Corrigido**

O backend já protegia corretamente (`requireRole("ADMIN")` em `routes/users.ts`,
`requireRole("ADMIN","ANALYST")` em `routes/audit.ts`) — **não era uma falha de
segurança real**, só UX ruim (usuário sem permissão via URL direta via uma tela
quebrada em vez de ser redirecionado). Corrigido com um componente `RoleGate` no
frontend espelhando exatamente as duas checagens de `requireRole` já existentes no
backend — nenhuma restrição nova foi inventada.

### 11. `AuditLog` não é tamper-evident
**Status: Corrigido (hash-chain a partir de agora)**

Cada `AuditLog` novo grava `prevHash`/`hash` (SHA-256, cadeia global entre tenants,
`services/auditIntegrity.ts`) — qualquer alteração ou remoção de uma linha existente
via acesso direto ao Postgres quebra a cadeia a partir dali, detectável via
`GET /api/audit-logs/verify-integrity` (ADMIN/ANALYST). Testado nesta sessão contra
Postgres real: `UPDATE` direto via SQL numa linha do meio da cadeia foi detectado
corretamente pelo endpoint (`valid: false`, apontando a linha exata).

**Limitação aceita**: as 17+ entradas gravadas antes desta mudança (`hash`/`prevHash`
nulos) não entram retroativamente na cadeia — não há como provar que não foram
alteradas antes de hoje. Sem lock explícito na leitura do "último hash" — sob escrita
concorrente real (rara neste volume) duas chamadas a `logAudit()` poderiam ler o mesmo
`prevHash`; isso apareceria como uma quebra de cadeia na verificação, indistinguível de
adulteração real (decisão deliberada, para não introduzir SQL cru/`$queryRaw` só para
um lock, ver comentário em `auditIntegrity.ts`).

### 12. IDOR em rotas `findUnique`/`update`/`delete`/`upsert` por id
**Status: Auditado — nenhum achado**

`tenantGuard.ts` documenta que essas operações (ao contrário de `findMany`/`updateMany`/
etc.) não são guardadas pela extensão do Prisma, por dependerem de um id já único.
Auditoria rota-por-rota das 9 arquivos que fazem essas operações
(`clients`, `notifications`, `users`, `segments`, `auth`, `templates`, `integrations`,
`tenant`, `automations`) confirmou que 100% seguem verify-then-act (`findFirst` com
`tenantId` antes do `update`/`delete`/`upsert` por id) ou são inerentemente seguras (id
vem do JWT/token assinado, nunca de parâmetro de URL — ex.: `auth.ts`, `tenant.ts`) ou
são um lookup de webhook autenticado por assinatura HMAC, não por sessão
(`integrations.ts`, `applyStatusUpdate`). Nenhuma correção de código necessária.

## Rodada GERALZONA (`perguntas.md`, 2026-09-04)

Segunda rodada de auditoria, pedida pelo usuário depois da finalização do RLS, cobrindo
3 perguntas amplas (exposição do banco Supabase, segurança do deploy Vercel, código
front+back) via 3 agentes de pesquisa paralelos com acesso a MCP (Supabase/Vercel) e
pesquisa externa. Achados novos abaixo; o que já estava corrigido foi re-verificado com
prova fresca (98/98 testes, `curl` real contra produção para headers/CORS, build limpo)
sem repetir aqui o que os achados #1-#12 já documentam.

### 13. Supabase Data API (PostgREST) habilitado, grants padrão abertos em `anon`/`authenticated`
**Status: Ação pendente (dashboard, fora do alcance de MCP/CLI)**

A app nunca usa `supabase-js`/PostgREST/GraphQL (confirmado por `grep`, zero ocorrências
em `backend/src`+`frontend/src`) — mas o Data API do projeto Supabase está ligado, e as
14 tabelas têm o grant padrão do Supabase (`SELECT/INSERT/UPDATE/DELETE` para `anon` e
`authenticated`) nunca revogado. Hoje isso é bloqueado pelo RLS (prova ao vivo: `curl`
contra `https://wgpoxmbpkgrcmfxgkdss.supabase.co/rest/v1/Client` com a anon key pública
devolveu `200 []`, não dados) — mas é o mesmo padrão estrutural do **CVE-2025-48757**
(CVSS 9.3, mai/2025, 303 endpoints em 170 apps Supabase/Lovable expostos): basta uma
migration futura criar uma tabela sem `ENABLE ROW LEVEL SECURITY` para ela ficar
instantaneamente legível/gravável por qualquer um com a anon key pública.

**Ação recomendada (decisão do usuário via grill-me: desligar completamente)**:
Dashboard do Supabase → Project Settings → Data API → Disable Data API. Não há
endpoint de Management API nem tool MCP para isso — confirmado via
`mcp__supabase__search_docs`, é um toggle de projeto, não uma configuração SQL/Postgres.
Alternativa mais granular (se algum dia o Data API precisar ficar ligado):
`REVOKE`/`ALTER DEFAULT PRIVILEGES` de `anon`/`authenticated` nas 14 tabelas — documentada
na fonte oficial, não aplicada aqui porque a decisão foi desligar de vez.

Fonte: [Supabase Docs — Securing your API](https://supabase.com/docs/guides/api/securing-your-api),
[CVE-2025-48757](https://www.brinztech.com/breach-alerts/brinztech-alert-critical-row-level-security-rls-vulnerability-cve-2025-48757-exposed-lovable-supabase-applications).

### 14. Integração Vercel↔Supabase órfã expondo `SUPABASE_SERVICE_ROLE_KEY` (bypassa RLS) em produção
**Status: Corrigido**

`vercel env ls production` revelou 16 env vars (`POSTGRES_*`/`SUPABASE_*`/
`NEXT_PUBLIC_SUPABASE_*`) injetadas automaticamente por uma integração Vercel
Marketplace↔Supabase conectada em algum momento (todas "14d ago"), nunca removida e
nunca referenciadas em nenhum lugar do código (`grep` confirmou zero uso). Entre elas,
`SUPABASE_SERVICE_ROLE_KEY` bypassa RLS por completo via PostgREST — presente sem
necessidade nenhuma, é superfície de ataque grátis para quem comprometer o
dashboard/CLI da conta Vercel.

Corrigido: as 16 variáveis removidas de produção via `vercel env rm` nesta sessão.
Nota da própria CLI, registrada aqui por transparência: remover a variável do Vercel
não revoga a credencial na origem — se quiser fechar 100% (inclusive contra alguém que
tenha copiado o valor antes desta remoção), rotacionar a `service_role key` e/ou o
JWT secret do projeto no dashboard do Supabase é o passo complementar, não aplicado
aqui (decisão do usuário, não solicitada nesta rodada).

### 15. Ambiente Preview sem env vars de banco (crash-loop silencioso) + sem proteção, compartilhando banco real
**Status: Corrigido**

Dois problemas encontrados juntos:

- **Preview estava com zero de `DATABASE_URL`/`DATABASE_URL_ADMIN`/`DIRECT_URL`**
  configuradas (não só senha antiga, como o snapshot anterior registrava — as 3 vars
  simplesmente não existiam para o ambiente Preview). Como `config/env.ts` exige as 3
  no boot (zod), todo deploy de Preview desde o merge do código RLS-aware
  provavelmente falhava ao subir. Não foi possível confirmar retroativamente por
  quanto tempo — o plano Hobby da Vercel só retém logs brutos por 1 hora
  (`get_runtime_logs`), e não há alerta configurado para crash de deploy.
- **Preview aponta para o mesmo banco Supabase de produção** (mesmas 370 linhas de
  clientes reais), sem nenhuma Deployment Protection — o repositório é público no
  GitHub, então qualquer PR/branch gera uma URL de Preview publicamente acessível.

Corrigido: as 3 env vars adicionadas ao Preview (mesmos roles `app_runtime`/`postgres`
usados em produção — Preview volta a ter RLS real, não um bypass). Vercel Authentication
(SSO) ligada no ambiente Preview dos dois projetos (`crmtopconta-backend` e
`crmtopconta-frontend`) via `mcp__vercel__update_project_deployment_protection` —
produção permanece sem proteção de deployment, intencionalmente (perímetro é o JWT da
app). Isolamento de dados (banco de teste separado para Preview) foi considerado e
descartado pelo usuário nesta rodada — custo/complexidade de manter dois bancos em
sincronia não justificou frente ao ganho de só adicionar Vercel Authentication.

**Limitação aceita**: não há alerta automático de deploy/crash-loop configurado — o
próximo gap desta natureza só será descoberto manualmente de novo, como este foi.

### 16. CSV export — formula injection
**Status: Corrigido**

`GET /api/clients/export.csv` (`routes/clients.ts`) escapava vírgula/aspas/quebra de
linha (RFC 4180) mas não neutralizava um valor começando com `=`/`+`/`-`/`@` — um nome
de cliente plantado via import (ex.: `=HYPERLINK("http://evil","x")`) vira fórmula
executável ao abrir o CSV no Excel/Sheets/LibreOffice (CWE-1236). Corrigido: `csvEscape()`
agora prefixa esses valores com `'` antes do escaping normal, forçando interpretação
como texto — mitigação padrão da OWASP CSV Injection cheat sheet.

### 17. Pacote de hardening menor (defesa em profundidade / UX)
**Status: Corrigido**

Três achados de baixa severidade, nenhum deles um vazamento ativo:

- **CORS**: rejeição de origem caía no error handler genérico (500) em vez de 403
  explícito — corrigido em `app.ts` (não vazava nada, só sujava logs/semântica HTTP).
- **JWT**: `jwt.verify()` sem allow-list explícita de `algorithms` — a lib
  (`jsonwebtoken@9.0.2`) já rejeita `alg:none` por padrão desde CVE-2015-9235, mas
  passar `{ algorithms: ["HS256"] }` explicitamente nos dois call sites de
  `middleware/auth.ts` é defesa em profundidade sem custo.
- **RoleGate (frontend)**: redirecionava silenciosamente para `/` ao bloquear acesso
  por papel, sem explicar por quê. Corrigido com um banner dispensável no `Layout`
  ("Você não tem permissão para acessar essa página"), lido via `sessionStorage` logo
  após o redirect.

## Confirmado como correto (nenhuma mudança necessária)

- **Envelope encryption** (`services/crypto.ts`): AES-256-GCM nativo do Node, IV novo
  por chamada via CSPRNG, auth tag verificado, falha fechada sem fallback fraco se
  `CREDENTIALS_ENCRYPTION_KEY` faltar.
- **Hash de CPF** (`services/masking.ts`): HMAC-SHA256 com salt por tenant (`uuid()`
  do Prisma, CSPRNG), nunca reversível, nunca logado. Dedupe (`services/dedupe.ts`)
  compara só por hash, sem oráculo de força bruta de CPF exposto publicamente.
- **Zero SQL cru**: `$queryRaw`/`$executeRaw` = 0 ocorrências em todo o backend;
  filtros de segmento usam só `Prisma.ClientWhereInput` tipado.
- **Credenciais de canal**: descriptografadas só em memória no envio, nunca
  logadas, sempre removidas da resposta da API.
- **Frontend**: sem `dangerouslySetInnerHTML`/`innerHTML`, sem nenhum segredo em
  `VITE_*`/bundle público (não existem env vars de frontend hoje), 401 limpa sessão e
  redireciona para `/login` corretamente.
- **Vercel**: produção sem proteção de deployment (SSO/senha/IP) nos dois projetos —
  esperado, já que o app tem seu próprio perímetro de autenticação (JWT); confirmado
  que não há rota admin/debug exposta sem `requireAuth`. Preview ganhou Vercel
  Authentication nesta rodada (achado #15) por compartilhar o banco real.
- **Runtime em produção**: os dois clusters de erro encontrados nos últimos 7 dias
  (falhas de prepared statement do pooler PgBouncer, timeouts de import) já estavam
  resolvidos por deploys anteriores a esta auditoria (`ea85209` e `82214bf`) — não são
  achados novos, apenas confirmados como não-recorrentes.

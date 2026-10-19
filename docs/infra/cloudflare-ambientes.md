# Cloudflare: ambientes, banco e deploy

Um só Worker serve a SPA (`frontend/dist`, assets com fallback de SPA) e a API (`/api/*` e `/r/*` passam
primeiro pelo Worker). Configuração em `backend/wrangler.jsonc`, entrada em `backend/worker/index.ts`, que
monta o mesmo Express do Node (`src/app.ts`) com `httpServerHandler` (`cloudflare:node`). `/api/health`
responde direto, sem passar pelo Express. A homologação roda a API inteira desde 19/10/2026 (Fase 5).

**Para retomar** (variáveis, subir a produção, testar disparos): `cloudflare-roteiro-producao.md`.

| Ambiente | Onde | Worker | D1 | R2 |
|---|---|---|---|---|
| Local | `wrangler dev` (Miniflare, nada na conta) | `crmtopconta-local` | simulado | simulado |
| Homologação | https://crmtopconta-hml.topcontamkt.workers.dev | `crmtopconta-hml` | `crmtopconta-hml` (ENAM, criado em 18/10/2026) | `crmtopconta-hml-media` (ENAM, 19/10/2026) |

Homologação também tem a fila `crmtopconta-hml-sync` (sync da planilha) e 3 Cron Triggers. Segredos do Worker
(`JWT_SECRET`, `CREDENTIALS_ENCRYPTION_KEY`, `CRON_SECRET`) foram gerados para ela e estão em
`backend/.dev.vars.hml` (fora do git, só na máquina de quem fez o deploy), junto com a senha dos usuários do seed;
para trocar: editar o arquivo e `npx wrangler secret bulk --env hml` com o JSON dos valores. Falta
`GOOGLE_SERVICE_ACCOUNT_JSON` (`npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON --env hml`).
| Produção | domínio a definir | — | — | — |

## Comandos (`cd backend`)

```bash
npm run db:migrate:local   # aplica migrations/ no D1 local
npm run prisma:seed        # gera prisma/seed.sql e aplica no D1 local (admin@topconta.demo / mudar123)
npm run cf:dev             # build do frontend + wrangler dev em http://localhost:8787
npm run cf:deploy:hml      # build do frontend + deploy da homologação
npx tsc -p worker/tsconfig.json   # typecheck do Worker (fora do tsconfig do backend)

# homologação (banco remoto): migrations antes do deploy que precisa delas
npx wrangler d1 migrations apply crmtopconta-hml --env hml --remote
```

O deploy usa o token da conta compartilhada em `backend/.dev.cloudflare` (fora do git):
`set -a; . ./.dev.cloudflare; set +a` antes do `wrangler`. Nunca commitar nem imprimir o token.

## Banco (Fase 2)

- **Schema**: `backend/prisma/schema.prisma` agora é SQLite (Prisma 7, `prisma-client` com
  `runtime = "cloudflare"`, gerado em `src/generated/prisma`, fora do git). Mudanças em relação ao Postgres:
  `User.areas` virou `Json`; `Client.tags` virou a tabela `ClientTag` (a API continua devolvendo lista de
  textos); `Movement` e `MessageEvent` ganharam `tenantId`; tipos `@db.*` saíram.
- **Migrations**: `backend/migrations/NNNN_nome.sql`, aplicadas pelo wrangler (`d1 migrations apply`). Gerar
  a próxima com `npx prisma migrate diff --from-schema <schema anterior> --to-schema prisma/schema.prisma
  --script -o migrations/0002_nome.sql`. Os `.sql` de `prisma/sql/` são histórico do Postgres.
- **Client** (`src/config/db.ts`): `prisma` é um Proxy montado no primeiro uso com o adapter que a entrada
  registrou (`configureDatabase`: `PrismaD1(env.DB)` no Worker, `PrismaBetterSqlite3` nos testes e no seed).
- **Isolamento** (`src/config/tenantGuard.ts`): sem RLS no SQLite, a extensão INJETA o `tenantId` do contexto
  em toda operação (inclusive `findUnique`/`update`/`delete`/`upsert`) e o preenche nos `create`; tenant
  explícito diferente do contexto é erro; sem contexto, toda query falha. Cross-tenant só com
  `withCrossTenantAccess`. Prova: `src/config/tenantIsolation.int.test.ts` (2 tenants × 6 models × todas as
  operações, num SQLite real com a migration do D1).
- **SQL cru** (`tenantRaw`): exige `"tenantId" = $1` com o tenant do contexto como 1º parâmetro e converte
  `$n` em `?` posicional (o better-sqlite3 não aceita `?1` com lista de valores; o D1 aceitaria). Dialeto do
  SQLite desde a Fase 4 (ver abaixo).
- **Sem `skipDuplicates`** no SQLite: a importação de compras filtra as transações já gravadas antes do
  `createMany`. **Sem `mode: "insensitive"`**: o LIKE do SQLite ignora caixa só em ASCII; a busca por nome
  usa `nomeBusca` (Fase 4).
- **Testes no Node**: o client gerado para a Cloudflare importa o WASM como `.wasm?module` e uma "cola" ESM;
  `jest.config.js` (moduleNameMapper) e `test/prismaNode.cjs` (para `ts-node -r`) apontam para versões que o
  Node carrega. O `better-sqlite3` é nativo: depois de `npm install`, se faltar o binário, `npm rebuild better-sqlite3`.

## Runtime (Fase 3)

- **Nada no escopo global** que use timer, sorteio ou I/O (o workerd recusa): os limitadores do
  `express-rate-limit` são criados na primeira requisição (`rateLimit` em `middleware/rateLimit.ts`) e o
  `node-cron` só existe no servidor Node (`src/index.ts`).
- **IP de quem chama**: só `CF-Connecting-IP` (`ipDoCliente` em `middleware/audit.ts`); `X-Forwarded-For` o
  cliente forja.
- **Trabalho depois da resposta**: `background(rotulo, promessa)` (`src/config/background.ts`); o Worker
  registra o `waitUntil`, senão a promessa é cancelada quando a resposta sai.
- **Cadeia da auditoria sem fila em memória**: `UNIQUE(tenantId, prevHash)` no `AuditLog` (migration `0002`);
  duas gravações que leem o mesmo topo não bifurcam, a segunda falha e `logAudit` relê e tenta de novo (até 8
  vezes). A 1ª entrada do tenant aponta para `GENESIS:{tenantId}`. Provado em `middleware/audit.int.test.ts`
  (20 gravações simultâneas) e no `wrangler dev` (15 edições em paralelo: cadeia válida, 0 bifurcações). O
  Prisma registra cada conflito no log como `Error in performIO ... UNIQUE constraint failed`: é esperado.
- **URLs públicas** só de `PUBLIC_BACKEND_URL` (vars do wrangler por ambiente) e `LINK_BASE_URL`
  (`src/config/publicUrl.ts`); sem elas as telas avisam em vez de gerar endereço da Vercel. A assinatura do
  Twilio é conferida contra `PUBLIC_BACKEND_URL` + caminho.
- **Envio simulado** só com `MESSAGING_MODE=mock` (local e homologação, no `wrangler.jsonc`), no lugar do
  antigo "NODE_ENV diferente de production".
- **QR code do 2FA** em SVG (o PNG dependia de canvas/zlib do Node).
- **Google Sheets sem `googleapis`** (`services/googleApi.ts`): JWT RS256 da Service Account assinado por
  WebCrypto e trocado por token de acesso (cache por escopo); a API REST do Sheets é chamada por `fetch`.
  Bundle do Worker: 1,83 MB compactado.
- **Mídias no R2** (`services/mediaStore.ts`, migration `0003_midia_no_r2`): o D1 não aceita linha acima de
  2 MB e as mídias vão até 4 MB. `WaMediaBlob` e `TemplateMedia` guardam só metadados e `storageKey`
  (`t/{tenantId}/wa/{messageId}` e `t/{tenantId}/tpl/{templateId}`). Gravar: objeto e depois linha. Apagar:
  objetos e depois linhas, para que uma falha do R2 deixe as linhas e a retenção tente de novo, em vez de
  sobrar arquivo com dado pessoal sem registro. Excluir template apaga a imagem antes (a cascata do banco
  não alcança o R2). "Limpar base" apaga os objetos antes das linhas (Fase 4).

## SQL cru no SQLite (Fase 4)

- **Colunas derivadas** (`src/config/derivedColumns.ts`, migration `0004_colunas_derivadas`): o SQLite não tem
  regex nem `lower()` com acento, então o que antes era calculado no SQL agora é gravado junto, em JS, por uma
  extensão do Prisma em todo create/update/upsert: `Client.cidadeKey` (= `cidadeKey()` de `cidades.ts`; substitui
  o `cidadeKeySql`), `Client.nomeBusca` (minúsculo, sem acento: busca de segmentos e da Inbox) e
  `Purchase.usoTipo` (`ANTECIPACAO`/`COMPRA`/`ASSINATURA`/..., de `classifyTransaction`; substitui o
  `USO_TIPO_SQL` de LIKEs). Gravar a coluna derivada à mão é erro. O preenchimento das linhas que já existiam na
  `0004` é aproximado (SQL); a homologação/produção nascem vazias, então não importa.
- **A `0004` foi escrita à mão** com `ALTER TABLE ADD COLUMN`: o `prisma migrate diff` gera reconstrução de tabela
  (`DROP TABLE` + `INSERT`), e no D1 o `PRAGMA foreign_keys=OFF` não vale, então o DROP apagaria em cascata
  as tabelas filhas. Regra para as próximas: conferir a saída do diff e reescrever toda reconstrução de tabela que
  tenha filhas. `src/config/migrationsSchema.int.test.ts` aplica todas as migrations num SQLite vazio e exige diff
  vazio contra o `schema.prisma`.
- **Helpers** (`src/config/sql.ts`): `sqlTs(d)` (data no formato gravado pelo Prisma, `...+00:00`, para comparar
  como texto), `agoraSql(dias)`, `diaBrt(col)` / `diaDoMesBrt(col)` (Brasília = UTC−3 o ano todo, sem horário de
  verão), `emLista($n)` (lista vai como **um** parâmetro JSON lido por `json_each`, por causa do limite de 100
  parâmetros do D1) e `usoRealSql`/`antecipacaoSql`.
- **Linhas do SQL cru** (`normalizeRawRows` em `config/db.ts`): o tipo de coluna calculada é adivinhado pelo valor
  e os adapters divergem (better-sqlite3: inteiro em BigInt; D1: texto ISO vira Date). `tenantRaw.query` devolve
  sempre inteiro como number e data como texto ISO.
- **Limpar base** (`PURGE_STEPS` em `routes/clients.ts`): sem bloco `DO` nem transação interativa no D1, vira uma
  sequência de DELETEs na ordem das chaves, depois de apagar as mídias do R2. Não é atômico: se cair no meio,
  repetir termina o serviço (cada passo só apaga o que sobrou).
- **Prova**: `src/routes/sqlCru.int.test.ts` sobe a API inteira sobre um SQLite com as migrations do D1 e dados
  montados (acentos, cidade com espaço, empresa sem cidade, compra fora da janela, assinatura) e confere os
  números de dashboard, uso no período, perfis de renda, oportunidades e todos os públicos, comércio, ciclos,
  anonimização e limpar base. No `wrangler dev` (D1 local) todas essas telas respondem 200.

## Crons (Fase 5)

- Os 7 jobs diários do antigo `backend/vercel.json` viram 3 Cron Triggers (`triggers.crons` no `wrangler.jsonc`,
  local e hml), porque o plano grátis dá **5 triggers para a conta inteira** (compartilhada): `0 3 * * *` retenção
  + BI, `0 6 * * *` sync da planilha + foto do dashboard, `0 9-11 * * *` disparo (9h), automações (10h) e
  segmentos (11h), todos em UTC e nos horários de antes. O `scheduled()` de `worker/index.ts` chama
  `runCronTrigger` (`src/services/cronTriggers.ts`): em ordem, falha de um não impede o seguinte, e o horário
  agendado vai para os jobs que comparam o cron de cada tenant. `/api/cron/*` (CRON_SECRET) continua para rodar à mão.
- Testar no local: `npx wrangler dev --test-scheduled` e
  `curl "localhost:8787/cdn-cgi/handler/scheduled?cron=0+9-11+*+*+*&time=<epoch em ms>"`.
- **Limite de CPU**: no grátis cada invocação tem 10 ms de CPU, inclusive o cron; a retenção e a foto com a base
  real não cabem nisso. Com o Workers Paid (até 15 min de CPU para cron) volta também a cadência curta do
  disparo (a cada 5 min). O deploy da homologação com esta config registra 3 triggers na conta; a produção
  precisaria de mais 3 (6 > 5 no grátis).

## Limites do D1 no código (Fase 5)

- **Consultas por invocação**: cada consulta é uma subrequisição a serviço interno, até **1.000** por invocação
  no grátis e 10.000 no pago (documentação de 10/2026; o "50 no grátis" do plano estava desatualizado). Um lote
  de importação de 400 linhas fazia 2.027 (cartões), 1.628 (cartões, atualizando) e 1.215 (genérico); agora
  faz 529, 560 e 479, e compras 89 (`src/routes/importQueries.int.test.ts` mede e falha acima de 1.000).
  O que mudou: upsert nativo do Prisma nos cartões (`tenantId` escalar; `tenant: { connect }` é escrita aninhada
  e vira ler + gravar + ler por linha), clientes existentes lidos em lote na importação genérica
  (`clientesExistentes` em `dedupe.ts`) e o guard do tenant mantendo a chave `tenantId_x` sem `tenantId` solto.
- **Parâmetros por consulta**: o D1 aceita ~100 e o adapter informa 98 ao Prisma. O Prisma 7.10 só divide
  sozinho um `in` longo em `findMany`/`findFirst`/`updateMany`/`deleteMany` com UM `in`, sem `orderBy` e sem
  `not`/`notIn`; `count`, `groupBy`, `aggregate`, `orderBy`, `not`, `notIn`, dois `in` ou OR montado a partir de
  uma lista dão **P2029** a partir de ~98 valores (medido). Nesses casos: `src/config/d1Partes.ts`
  (`dividirIn`/`buscarEmPartes`/`contarEmPartes` partem um `where` com `id: { in }` longo em pedaços de 90;
  `partes` para laços), ordenar em JS ou trocar o OR por um `in` por coluna. SQL cru: lista como um parâmetro
  JSON (`emLista`). Já corrigidos (auditoria dos 82 `in` do código): público por lista de clientes (campanha,
  estimativa, assistente e dedupe, automação), "autorizados" do dashboard e do comércio, relatório da campanha,
  campanha por planilha e desfazer importação; provados com 150 clientes em `src/routes/listasLongas.int.test.ts`.
- **Testes com os limites**: os testes de integração e o seed usam `d1LikeAdapter` (`src/config/d1Like.ts`):
  o better-sqlite3 não tem esses limites, então antes os testes passavam e o Worker quebrava.
- **Sync da planilha**: importar a planilha inteira numa invocação não cabe (~1 consulta por linha); vai em
  páginas pela fila (ver "Fila do sync da planilha" abaixo).
- **Linhas lidas/gravadas por dia** (grátis, cobrado desde 01/09/2026 para a conta toda): 5 milhões lidas e
  100 mil gravadas. Uma importação de 5 mil clientes grava ~4 linhas por cliente (cliente, histórico de saldo,
  desfazer, movimento) mais índices.

## Fila do sync da planilha (Fase 5)

`src/services/sheetSync.ts`. Queues valem no grátis desde 02/2026 (10 mil operações/dia, retenção de 24 h): cada
página de 200 linhas custa ~3 operações (gravar, ler, apagar), ~3.300 páginas/dia.

- "Sincronizar agora" (`POST /api/imports/google-sheets`) e o cron das 06:00 só põem a 1ª página na fila
  (resposta 202 `{ enfileirado, loteId }`). O consumidor (`queue()` em `worker/index.ts`, `max_batch_size` 1)
  confere que a planilha continua cadastrada no tenant, lê do Google só o cabeçalho e a página (`values:batchGet`,
  `fetchSheetPage`), importa com o mesmo `loteId` e o número de linha da planilha, e põe a próxima se a página
  veio cheia. Na última: `lastSyncAt`, ciclo das cidades e o AuditLog `IMPORT_GOOGLE_SHEETS` com os totais.
- A mensagem leva só a posição (tenant, planilha, range, mapeamento, linha inicial) e contagens: nenhum dado da
  planilha (CPF, telefone) fica na fila.
- Erro: a fila tenta de novo (`max_retries` 3; reimportar a página é seguro, a última atualização ganha). Na 4ª
  falha, notificação `IMPORT_FAILED` para o tenant e a mensagem sai. Teto de 250 páginas (50 mil linhas) por sync.
- Diferença do sync de uma vez: "coluna ausente não zera" é decidido por página.
- Sem fila (Node, testes) roda tudo numa vez, como antes. Testado na homologação em 19/10/2026: 202 em 1,25 s, 4
  tentativas e a notificação (ainda sem a credencial do Google). Ficou cadastrada a planilha de mentira
  `TESTE_FILA_HML` no tenant demo (cron `0 0 1 1 *`); trocar pela real em Integrações.

## Onde o Worker roda (latência do D1)

Cada consulta do Worker ao D1 da homologação levava **~170 ms** (`latenciaBancoMs`): o D1 fica no leste dos EUA
(ENAM; não há região na América do Sul) e o Worker rodava no ponto da Cloudflare mais perto de quem acessa (Brasil).
Na homologação o Worker agora roda perto do banco (`"placement": { "region": "aws:us-east-1" }`, vale em todos os
planos; o cabeçalho `cf-placement: remote-IAD` confirma). Medido em 19/10/2026:

| | Sem placement | Com placement |
|---|---|---|
| Consulta ao D1 (health) | 173 ms | 51 ms |
| Importação de 100 linhas (cartões) | 5,5–6,2 s | 2,2–2,9 s |
| Telas leves (login, listas) | — | 0,2–0,5 s mais lentas (ida e volta Brasil → EUA) |
| Dashboard (overview) | — | um pouco mais rápido |

O Smart Placement (`"mode": "smart"`) não serve: decide pelo tráfego e precisa de volume constante. Para a produção
é decisão do Filipe (o mesmo trade-off; telas que fazem muitas consultas ganham, telas leves perdem um pouco).

## Quando passar ao Workers Paid (US$ 5/mês)

Hoje tudo roda no grátis. O plano é da conta (compartilhada): vale para todos os Workers dela. Na troca:

1. **Crons**: trocar `triggers.crons` de cada ambiente no `wrangler.jsonc` por `CRON_TRIGGERS_PAGO`
   (`src/services/cronTriggers.ts`: disparo, sync e segmentos a cada minuto, automações a cada 5 min, retenção/BI às
   03:00, foto às 06:30). O código já entende os dois conjuntos; o teste confere que cada ambiente usa um inteiro.
   No grátis só cabem 5 triggers na conta, por isso a produção ainda não tem os seus.
2. **CPU**: acrescentar `"limits": { "cpu_ms": 60000 }` em cada ambiente (configuração só do plano pago). No grátis o
   teto nominal é 10 ms; na homologação o p50 foi 14,5 ms e o p99 526 ms sem corte (a Cloudflare tolera picos), mas
   importações grandes e a retenção com a base real podem ser cortadas.
3. **Consultas por invocação**: 10.000 em vez de 1.000. O lote de importação (400 linhas, ~530 consultas) já cabe
   nos dois; páginas maiores no sync (`SYNC_CHUNK`) passam a ser possíveis.
4. **D1**: 25 bilhões de linhas lidas e 50 milhões gravadas por mês incluídas (o grátis dá 5 milhões lidas e 100 mil
   gravadas por dia).
5. **Produção**: criar Worker/D1/R2/fila `crmtopconta-prod*` (precisa de OK), decidir o placement e o domínio
   (DNS só com OK).

## Estado

- **Fase 1** (19/10/2026): o `workers.dev` abre a tela de login e o `/api/health` responde 200.
- **Fase 2** (19/10/2026): schema no D1 (local e homologação, `0001_init`, 29 tabelas), Prisma 7 + guard no
  Worker, seed local, 946 testes passando. Na homologação: bundle de 1,25 MB compactado (limite do grátis:
  3 MB), inicialização de 20 ms, sem erro de CPU no plano grátis.
- **Fase 3** (só local, sem deploy): a API inteira roda no `wrangler dev` (login, 2FA, clientes,
  etiquetas, segmentos, usuários, relatório do titular, auditoria, mídias no R2).
- **Fase 4** (19/10/2026, só local, sem deploy): SQL cru no dialeto do SQLite; dashboard, oportunidades, uso no
  período, comércio e ciclos respondem no `wrangler dev`. 982 testes passando. Migrations `0002`, `0003` e `0004`
  aplicadas só no D1 local; na homologação, aplicar (`--remote`) antes do próximo deploy.
- **Fase 5** (19/10/2026, homologação no ar, plano grátis): migrations `0002`–`0004` aplicadas no remoto, seed
  (1 tenant, 3 usuários, 40 clientes), crons, limites do D1 no código, placement e fila do sync. Smoke na
  homologação: login, dashboard, clientes, campanhas, cadeia do AuditLog válida, importação de 100 linhas, crons
  por `/api/cron/*`, cabeçalho de template no R2 e a fila do sync. 1.020 testes passando.

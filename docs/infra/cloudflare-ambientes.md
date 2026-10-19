# Cloudflare: ambientes, banco e deploy

Um só Worker serve a SPA (`frontend/dist`, assets com fallback de SPA) e a API (`/api/*` e `/r/*` passam
primeiro pelo Worker). Configuração em `backend/wrangler.jsonc`, entrada em `backend/worker/index.ts`, que
monta o mesmo Express do Node (`src/app.ts`) com `httpServerHandler` (`cloudflare:node`). `/api/health`
responde direto, sem passar pelo Express. A homologação ainda roda a versão da Fase 2 (só o health).

| Ambiente | Onde | Worker | D1 | R2 |
|---|---|---|---|---|
| Local | `wrangler dev` (Miniflare, nada na conta) | `crmtopconta-local` | simulado | simulado |
| Homologação | https://crmtopconta-hml.topcontamkt.workers.dev | `crmtopconta-hml` | `crmtopconta-hml` (ENAM, criado em 18/10/2026) | `crmtopconta-hml-media` (ENAM, 19/10/2026) |
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
- **Ainda não cabe no grátis**: o sync da planilha do Google importa a planilha inteira numa invocação (~1
  consulta por linha: 5 mil linhas = ~5 mil consultas) e a CPU de 10 ms por invocação não comporta nem um lote.
  Com o Workers Paid o lote cabe; o sync grande vai para uma Queue (Fase 5, precisa de OK para criar).
- **Linhas lidas/gravadas por dia** (grátis, cobrado desde 01/09/2026 para a conta toda): 5 milhões lidas e
  100 mil gravadas. Uma importação de 5 mil clientes grava ~4 linhas por cliente (cliente, histórico de saldo,
  desfazer, movimento) mais índices.

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

## Decisão pendente para a Fase 3: onde o Worker roda (latência do D1)

Cada consulta do Worker ao D1 da homologação leva **~150 ms** (`latenciaBancoMs` do health): o D1 fica nos EUA
(ENAM; não há região na América do Sul) e o Worker roda no ponto da Cloudflare mais perto de quem acessa
(Brasil). Uma tela que faz 5 consultas em sequência gastaria ~0,75 s só de ida e volta. A alternativa é o
**Smart Placement** (`"placement": { "mode": "smart" }` no `wrangler.jsonc`): a Cloudflare passa a rodar o
Worker perto do banco, e o custo vira uma ida e volta só (navegador → Worker, ~150 ms) por requisição.
Medir na Fase 3, com a API real, as duas formas no login e no dashboard antes de decidir.

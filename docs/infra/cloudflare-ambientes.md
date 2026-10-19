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
  `$n` em `?` posicional (o better-sqlite3 não aceita `?1` com lista de valores; o D1 aceitaria). As 42
  queries ainda estão no dialeto do Postgres e são reescritas na Fase 4; o `PURGE_SQL` (bloco `DO`) vira `batch`.
- **Sem `skipDuplicates`** no SQLite: a importação de compras filtra as transações já gravadas antes do
  `createMany`. **Sem `mode: "insensitive"`**: o LIKE do SQLite ignora caixa só em ASCII; busca sem acento
  entra com `nomeBusca` na Fase 4.
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
  não alcança o R2). Pendente na Fase 4: o `PURGE_SQL` de `routes/clients.ts` apaga linhas de `WaMediaBlob`
  direto no SQL e precisa passar a apagar os objetos.

## Estado

- **Fase 1** (19/10/2026): o `workers.dev` abre a tela de login e o `/api/health` responde 200.
- **Fase 2** (19/10/2026): schema no D1 (local e homologação, `0001_init`, 29 tabelas), Prisma 7 + guard no
  Worker, seed local, 946 testes passando. Na homologação: bundle de 1,25 MB compactado (limite do grátis:
  3 MB), inicialização de 20 ms, sem erro de CPU no plano grátis.
- **Fase 3, em andamento** (só local, sem deploy): a API inteira roda no `wrangler dev` (login, 2FA, clientes,
  etiquetas, segmentos, usuários, relatório do titular, auditoria). Ainda falham com 500 as telas que usam SQL
  cru do Postgres (dashboard, oportunidades, uso no período, comércio, ciclos), que é a Fase 4. Migrations
  `0002_auditoria_elo_unico` e `0003_midia_no_r2` aplicadas só no D1 local; na homologação, aplicar antes do
  próximo deploy.

## Decisão pendente para a Fase 3: onde o Worker roda (latência do D1)

Cada consulta do Worker ao D1 da homologação leva **~150 ms** (`latenciaBancoMs` do health): o D1 fica nos EUA
(ENAM; não há região na América do Sul) e o Worker roda no ponto da Cloudflare mais perto de quem acessa
(Brasil). Uma tela que faz 5 consultas em sequência gastaria ~0,75 s só de ida e volta. A alternativa é o
**Smart Placement** (`"placement": { "mode": "smart" }` no `wrangler.jsonc`): a Cloudflare passa a rodar o
Worker perto do banco, e o custo vira uma ida e volta só (navegador → Worker, ~150 ms) por requisição.
Medir na Fase 3, com a API real, as duas formas no login e no dashboard antes de decidir.

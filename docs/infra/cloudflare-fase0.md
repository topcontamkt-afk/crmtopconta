# Fase 0: spike local da migração para a Cloudflare (19/10/2026)

Plano: migração do CRM do zero para Workers + D1 + R2 (decisão do Filipe, 19/10/2026). Spike em `spikes/cloudflare/`,
rodado só localmente (`wrangler dev`, D1 local do Miniflare). **Nada foi criado na conta da Cloudflare.**

Versões: wrangler 4.147.0, Prisma 7.10.0 (`prisma-client`, `runtime = "cloudflare"`), `@prisma/adapter-d1` 7.10.0,
`compatibility_date` 2026-10-01 com `nodejs_compat`.

## Veredito: GO

O caminho Prisma 7 + D1 + Express funcionou com o schema real (28 modelos). Os pontos que poderiam derrubar o plano
(bundle, transação, injeção de `tenantId`, limites de parâmetros) passaram ou têm contorno simples.

## Resultados

| Pergunta | Resultado | Consequência |
|---|---|---|
| O schema real converte para SQLite? | **Sim.** Conversão automática (`scripts/convert-schema.py`): tira `@db.*`, `String[]` vira `Json`. `prisma generate` ok; migration `0001_init.sql` com 28 tabelas e 50 índices | Enums, `Decimal`, `Json` e `Bytes` são aceitos no SQLite pelo Prisma 7 |
| Tamanho do bundle | **5,4 MB (1,6 MB compactado)**, com o compilador de queries em WASM (3,3 MB) | Cabe com folga (limite atual: 64 MB descompactado) |
| Express 4 no workerd | **Quebra ao carregar**: `iconv-lite` 0.4.24 (do `body-parser` 1.x) falha no bundle. **Contorno:** `overrides: { "iconv-lite": "0.7.3" }`, mesma API | Aplicar o override no backend (ou subir para Express 5 depois) |
| Filtro extra de `tenantId` no `findUnique` | **Funciona**: outro tenant devolve `null`, mesmo tenant encontra | Base da injeção de `tenantId` no `tenantGuard` (decisão 3 do plano) |
| `createMany` com 300 linhas × várias colunas | **Ok (300)**: o adapter fatia sozinho | Não precisa de `inChunks` para `createMany` |
| `findMany` com `in:` de 2000 ids | **Ok** | Não precisa de `inChunks` para `in:` do Prisma (o SQL cru ainda precisa) |
| Formato do `DateTime` no D1 | **Texto ISO** (`2026-10-19T02:48:09.979Z`) | Fragmentos de SQL cru usam `strftime`/`datetime()` sobre texto ISO |
| `Decimal` e `Json` | Ida e volta ok (`1234.56`, `["vip"]`) | — |
| `upsert` por unique composto (`tenantId_cpfHash`) | **Ok** | Padrão das importações continua |
| `$transaction` interativa | **Lança erro claro** ("Cloudflare D1 does not support interactive transactions") e não grava nada | Bom: falha alta, não silenciosa. O `tenantGuard` atual (uma transação por query) tem que sair, como previsto |
| Transações implícitas do Prisma | Aviso: viram queries soltas, sem ACID | Fluxos que precisam ser atômicos usam `env.DB.batch()` |
| `bcryptjs` custo 10 (async e sync) | **Ok** | CPU real só mede no deploy (Fase 1/3) |
| `jsonwebtoken`, `otplib`, AES-256-GCM, HMAC, `timingSafeEqual` | **Ok** | Sem troca de biblioteca |
| `qrcode.toDataURL` (PNG) | **Trava a requisição** (zlib/pngjs) | Trocar por `QRCode.toString(..., { type: "svg" })` em data URL SVG, testado ok. Muda 1 linha em `backend/src/services/twoFactor.ts:22` |
| Rota própria antes do Express + WebSocket (`WebSocketPair`) | **Ok** (eco pelo WebSocket) | A ponte de voz entra antes do Express, como no plano |
| `scheduled()` no mesmo Worker | **Ok** (dois crons gravaram no D1) | Crons sem HTTP, como no plano |

## O que o spike não mede (fica para o deploy em homologação)

- **CPU real por requisição e no cold start.** O local não reproduz o limite de 10 ms do plano grátis. Pela experiência
  com bcrypt (custo 10), o login não deve caber no grátis: confirmar na Fase 1 e assinar o Paid na Fase 3.
- **Tempo de inicialização** com o WASM de 3,3 MB (limite de 1 s).
- **Jest com o cliente do Prisma 7**: o cliente gerado para `cloudflare` importa WASM. Na Fase 2, gerar um segundo cliente
  (`runtime = "nodejs"`) só para os testes de integração com better-sqlite3, ou passar os testes para Vitest.

## Notas de execução

- O Prisma 7 exige `datasource.url` no `prisma.config.ts` até para `migrate diff --from-empty`. Sem isso, a saída sai
  **vazia e sem erro**. O spike usa um SQLite local descartável.
- O npm bloqueia scripts de instalação. Foram aprovados (`allowScripts` no `package.json`) só os de `prisma`,
  `@prisma/engines`, `esbuild` e `workerd`, todos necessários.

## Como reproduzir

```bash
cd spikes/cloudflare
npm install
npx prisma generate
npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script -o prisma/migrations/0001_init.sql
npx wrangler d1 execute crmtopconta-spike --local --file=prisma/migrations/0001_init.sql
npx wrangler dev                       # local; rotas /api/health, /api/spike/db, /api/spike/lib/:nome, /api/spike/ws
npx wrangler deploy --dry-run --outdir dist   # mede o bundle, não publica
```

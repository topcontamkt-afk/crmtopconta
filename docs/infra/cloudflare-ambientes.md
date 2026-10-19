# Cloudflare: ambientes e deploy (Fase 1)

Um só Worker serve a SPA (`frontend/dist`, assets com fallback de SPA) e a API (`/api/*` e `/r/*` passam
primeiro pelo Worker). Configuração em `backend/wrangler.jsonc`, entrada em `backend/worker/index.ts`.
Na Fase 1 a API é só um esqueleto: `/api/health` (faz `SELECT 1` no D1) responde e o resto devolve
`503 EM_MIGRACAO`. A API real (Express + Prisma 7 + D1) entra nas Fases 2 e 3.

| Ambiente | Onde | Worker | D1 | R2 |
|---|---|---|---|---|
| Local | `wrangler dev` (Miniflare, nada na conta) | `crmtopconta-local` | simulado | simulado |
| Homologação | `crmtopconta-hml.<subdomínio>.workers.dev` | `crmtopconta-hml` | `crmtopconta-hml` (ENAM, criado em 18/10/2026) | `crmtopconta-hml-media` (falta ativar o R2) |
| Produção | domínio a definir | — | — | — |

## Comandos (`cd backend`)

```bash
npm run cf:dev          # build do frontend + wrangler dev em http://localhost:8787
npm run cf:deploy:hml   # build do frontend + deploy da homologação
npx tsc -p worker/tsconfig.json   # typecheck do Worker (fora do tsconfig do backend)
```

O deploy usa o token da conta compartilhada em `backend/.dev.cloudflare` (fora do git):
`set -a; . ./.dev.cloudflare; set +a` antes do `wrangler`. Nunca commitar nem imprimir o token.

## Antes do primeiro deploy da homologação (no painel da Cloudflare)

1. Abrir **Workers & Pages** uma vez: isso cria o subdomínio `*.workers.dev` da conta.
2. Ativar o **R2** (pede cartão mesmo no plano grátis) e depois criar o bucket `crmtopconta-hml-media`
   e incluir o binding `MEDIA` em `env.hml`.

Pronto (critério da Fase 1) quando o `workers.dev` abrir a tela de login e o `/api/health` responder 200.

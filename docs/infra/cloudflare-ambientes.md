# Cloudflare: ambientes e deploy (Fase 1)

Um só Worker serve a SPA (`frontend/dist`, assets com fallback de SPA) e a API (`/api/*` e `/r/*` passam
primeiro pelo Worker). Configuração em `backend/wrangler.jsonc`, entrada em `backend/worker/index.ts`.
Na Fase 1 a API é só um esqueleto: `/api/health` (faz `SELECT 1` no D1) responde e o resto devolve
`503 EM_MIGRACAO`. A API real (Express + Prisma 7 + D1) entra nas Fases 2 e 3.

| Ambiente | Onde | Worker | D1 | R2 |
|---|---|---|---|---|
| Local | `wrangler dev` (Miniflare, nada na conta) | `crmtopconta-local` | simulado | simulado |
| Homologação | https://crmtopconta-hml.topcontamkt.workers.dev | `crmtopconta-hml` | `crmtopconta-hml` (ENAM, criado em 18/10/2026) | `crmtopconta-hml-media` (ENAM, 19/10/2026) |
| Produção | domínio a definir | — | — | — |

## Comandos (`cd backend`)

```bash
npm run cf:dev          # build do frontend + wrangler dev em http://localhost:8787
npm run cf:deploy:hml   # build do frontend + deploy da homologação
npx tsc -p worker/tsconfig.json   # typecheck do Worker (fora do tsconfig do backend)
```

O deploy usa o token da conta compartilhada em `backend/.dev.cloudflare` (fora do git):
`set -a; . ./.dev.cloudflare; set +a` antes do `wrangler`. Nunca commitar nem imprimir o token.

## Estado

Fase 1 concluída em 19/10/2026: o `workers.dev` abre a tela de login e o `/api/health` responde 200 com
`banco: ok` e `r2: true` (latência do D1 a partir do Worker ≈ 165 ms na primeira chamada).

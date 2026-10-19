# Estudo de custo: Vercel × Cloudflare (outubro/2026)

Tarefa 2, parte 2. Base: `claude/dreamy-brown-hvs4h6` (`ae214bc`, o que roda em produção), branch `claude/estudo-cloudflare`.
Nada foi criado na Cloudflare, nada foi publicado, DNS intocado, sem credencial de banco. Preços consultados em 18/10/2026 nas páginas
oficiais (links no fim). Câmbio: PTAX ~R$ 5,0–5,1 por US$ (out/2026); contas abaixo com R$ 5,05, sem impostos.

## Resumo

- **Hoje o custo de hospedagem é R$ 0**: Vercel Hobby (os dois projetos) + Supabase (banco de 65 MB; plano não confirmado, o tamanho
  cabe no Free).
- **Mas o Hobby não pode ser usado comercialmente.** Termos da Vercel: *"Hobby teams are restricted to non-commercial personal use
  only. All commercial usage of the platform requires either a Pro or Enterprise plan"*, e uso comercial inclui *"a paid employee or
  consultant writing the code"*. O CRM da TopConta é comercial. A comparação honesta é **Vercel Pro (US$ 20/mês ≈ R$ 101)** ×
  **Cloudflare Workers Paid (US$ 5/mês ≈ R$ 25)**.
- **Economia possível com a Cloudflare: ~US$ 15/mês (≈ R$ 76/mês, ≈ R$ 910/ano).** Custo da migração: **~10 a 14 dias de
  desenvolvimento**, mais risco operacional (troca de domínio dos links rastreados que estão dentro de templates aprovados pela Meta,
  reconfiguração de webhooks da Meta/Twilio/Z-API). O retorno leva anos.
- **Recomendação: não migrar agora.** Regularizar indo para o **Vercel Pro**, que resolve com zero código os problemas que hoje são
  perceptíveis (cron 1x/dia → a cada minuto; campanha agendada sai na hora). Cloudflare só para um caso pontual, ver "Quando a
  Cloudflare passa a valer".

## 1. Custo atual e cenários (mensal)

| Item | Hoje | Cenário A: Vercel Pro | Cenário B: Cloudflare | Fonte |
|---|---|---|---|---|
| Hospedagem backend + frontend | Vercel Hobby, US$ 0 (**fora dos termos**) | US$ 20 (1 assento dev; inclui US$ 20 de crédito de uso; Viewer grátis) | Workers Paid US$ 5 (10 mi req, 30 mi CPU-ms; estáticos ilimitados e grátis) | vercel.com/docs/plans/pro-plan; developers.cloudflare.com/workers/platform/pricing |
| Banco | Supabase (plano não confirmado; 65 MB) | igual | igual (via Hyperdrive, incluído no Workers Paid) | supabase.com/pricing |
| Crons | 7, no máx. 1x/dia | até a cada 1 min | Cron Triggers a cada 1 min (250 por conta) | vercel.com/docs/cron-jobs/usage-and-pricing; developers.cloudflare.com/workers/configuration/cron-triggers |
| Corpo de requisição/resposta | 4,5 MB | 4,5 MB | 100 MB / sem limite (memória do isolate: 128 MB) | limits das duas |
| WhatsApp (Meta), Twilio, xAI, Z-API | por uso | **igual** | **igual** | não dependem da hospedagem |
| **Total de hospedagem** | **US$ 0** | **US$ 20 ≈ R$ 101** | **US$ 5 ≈ R$ 25** | |

Observações:
- O uso real da Vercel não pôde ser medido: o plano Hobby não dá acesso às métricas de observabilidade nem à cobrança pela API. Pelo
  volume (1 tenant, ~3,5 mil clientes, ~40 mil linhas, poucos usuários internos), o provável é caber no crédito de US$ 20 do Pro.
  Para confirmar: painel da Vercel → Usage, últimos 30 dias (invocações, Active CPU, Fast Data Transfer).
- Assento extra de desenvolvedor no Pro custa US$ 20/mês. Se mais de uma pessoa precisar fazer deploy, a diferença para a Cloudflare
  cresce (a Cloudflare não cobra por assento).
- **Workers Free não serve**: 10 ms de CPU por requisição (o login com bcrypt custo 10 sozinho passa disso), 5 crons por conta (são 7),
  50 subrequests por invocação (o disparo de campanha faz até 100 chamadas à Meta por lote).

### Supabase (vale nos dois cenários)

O banco cabe no Free (500 MB), mas o Free **não tem backup** e pausa após 7 dias sem atividade (os crons diários evitam). Sem backup
é um risco de disponibilidade e de segurança (LGPD art. 46). Recomendação separada da hospedagem: confirmar o plano atual e
considerar o **Supabase Pro (US$ 25/mês ≈ R$ 126; backup diário por 7 dias)**. Isso não muda a comparação Vercel × Cloudflare.

## 2. O que roda direto, o que exige adaptação e o que não roda (Workers)

Caminho de menor atrito na Cloudflare: manter o Express inteiro via `node:http` + `httpServerHandler` (suportado oficialmente, com
`nodejs_compat`), um único Worker servindo o frontend como static assets e a API em `/api/*`, banco via Hyperdrive.

| Item | Situação | O que fazer | Esforço |
|---|---|---|---|
| Express, helmet, cors, zod, libphonenumber-js, otplib, qrcode, jsonwebtoken | Roda direto | Testar Express 4 no `workerd` | P |
| `node:crypto` (HMAC, AES-256-GCM, `timingSafeEqual`, `randomBytes`), Buffer, `AsyncLocalStorage` (RLS) | Roda direto | — | — |
| Verificação de webhooks (`rawBody` da Meta, urlencoded do Twilio, segredo da Z-API) | Roda direto | Conferir `x-forwarded-proto` na URL assinada do Twilio | P |
| bcryptjs custo 10 (`routes/users.ts:40`, `routes/auth.ts:158`) | Roda só no Paid | — | — |
| Crons (`backend/vercel.json`) | Adaptação | Handler `scheduled()` chamando as funções de `services/scheduler.ts`; tirar `node-cron` do bundle | P (0,5 d) |
| `dotenv` e `config/env.ts` com `throw` na carga | Adaptação | Variáveis como secrets do Worker | P |
| **Prisma 5.19 com engine nativo** (`config/db.ts`, `config/tenantGuard.ts`) | **Não roda como está** | Subir para 6.16+/7 (cliente sem Rust) + `@prisma/adapter-pg`; dois Hyperdrive (role `app_runtime` e admin) apontando para a conexão direta (não a 6543); cliente **por requisição** (Proxy + AsyncLocalStorage para não tocar os ~50 arquivos que importam `prisma`); pool ≤ 5 (limite de 6 conexões por invocação); `CONCURRENCY` 8 → 4 em `cardAccountImport.ts:100`. Cada operação abre transação com `set_config('app.tenant_id', …, true)`: 4 idas e voltas, então Smart Placement perto do Supabase | **G (3–5 d)** |
| `googleapis` (`services/googleSheets.ts`) | Não roda (bundle enorme, `fs`/`child_process`) | Reescrever as 5 chamadas REST com `fetch` + JWT de Service Account via WebCrypto | M (1 d) |
| Ponte de voz (`api/voice-bridge.ts`, `ws` + `http.Server`) | Não roda como está | `WebSocketPair` + `fetch` com `Upgrade` para a xAI, reaproveitando `services/voiceBridge.ts` (pura) | M (1–1,5 d) |
| `express-rate-limit` em memória (`req.ip`) | Adaptação | `keyGenerator` com `cf-connecting-ip` ou binding de Rate Limiting | P (0,5 d) |
| Export CSV com `take: 50000` em memória (`routes/clients.ts:55`) | Adaptação (128 MB por isolate) | `select` enxuto + paginação/stream | P (0,5 d) |
| Frontend: `@vercel/speed-insights` (`frontend/src/main.tsx`), rewrites (`frontend/vercel.json`) | Adaptação | Static assets com fallback de SPA no mesmo Worker (some o CORS); tirar o pacote da Vercel | P (0,5 d) |
| Domínio `*.vercel.app` fixo como padrão (`trackedLinks.ts:12`, `integrations.ts:146`, `tenantWhatsapp.ts:29`, `voice.ts:15`) e webhooks externos | Adaptação **operacional** | O domínio dos links rastreados está **dentro dos templates aprovados pela Meta**: manter `crmtopconta-backend.vercel.app` redirecionando `/r/*` ou reenviar os templates; reconfigurar Meta, Twilio e Z-API | M (1 d) |
| Fila de auditoria em memória (`filaPorTenant`, só na branch LGPD, PR #8) | Adaptação | Promise encadeada entre requisições não é permitida em Workers; trocar por `pg_advisory_xact_lock` por tenant (resolve também a bifurcação entre instâncias da Vercel) | P (0,5 d) |
| Calling API do WhatsApp (WebRTC/UDP, planejada) | **Não roda** em Workers nem na Vercel | Segue o plano do Fly.io (ou avaliar Cloudflare Realtime, não verificado) | fora do escopo |

**Total: ~10 a 14 dias** (código ~8–10 d, sendo o Prisma 3–5 d; homologação ponta a ponta 2–4 d: importações, latência do dashboard
com Hyperdrive, webhooks reais, disparo, link rastreado).

## 3. Aplicando a regra "troca só com justificativa"

A regra pede impacto perceptível e causa atribuível. Os problemas perceptíveis de hoje e a causa de cada um:

| Problema perceptível | Causa | Vercel Pro resolve? | Cloudflare resolve? |
|---|---|---|---|
| Disparo, automação e atualização de segmentos só 1x/dia; campanha agendada não sai na hora | Cron do Hobby limitado a 1x/dia | Sim, sem código (voltar a cadência em `backend/vercel.json`) | Sim, com a migração |
| Uso fora dos termos da Vercel | Hobby é não comercial | Sim | Sim |
| Mídia da Inbox até 4 MB, anexo até 3 MB | Limite de 4,5 MB por requisição/resposta | Não | Sim |
| Ponte de voz por WebSocket não verificada | WebSocket em funções da Vercel está em beta (exige Fluid Compute; não confirmado com a configuração `builds`/`routes`); limite de 300 s por conexão | Talvez (testar) | Sim (`WebSocketPair` nativo) |

Os dois primeiros, que afetam a operação de campanhas, são resolvidos pelo Pro sem mudar código. O limite de 4 MB é um incômodo
menor (o volume de mídia na Inbox hoje é baixo). A diferença de custo (US$ 15/mês) não paga 10–14 dias
de migração mais o risco de mexer em links aprovados pela Meta. **A troca de tecnologia não se justifica hoje.**

## 4. Quando a Cloudflare passa a valer

- **Só a ponte de voz num Worker (híbrido).** Se o teste da fase 1 mostrar que o WebSocket não funciona na Vercel, um Worker pequeno
  só com `/voice-bridge` resolve: ~1–1,5 dia, US$ 5/mês, sem tocar no resto do CRM nem no banco (a ponte só fala com Twilio e xAI).
  Causa atribuível e impacto claro, dentro da regra.
- **Conta da Vercel Pro passando bem do crédito de US$ 20**, ou vários assentos de desenvolvedor: aí a diferença mensal cresce e a
  migração completa volta à mesa.
- **Necessidade de arquivos grandes** (mídia acima de 4 MB na Inbox, importações maiores): R2 + Workers tiram o limite.

## 5. Próximos passos sugeridos (decisão do Filipe)

1. Assinar o Vercel Pro na equipe `topcontamkt-4608's projects` e restaurar a cadência dos crons em `backend/vercel.json` (dispatch e
   automações a cada poucos minutos, como em `services/scheduler.ts`). Mudança de 1 arquivo, em PR separado.
2. Conferir o plano do Supabase e decidir sobre o Pro por causa do backup.
3. Depois do teste da ponte de voz: se falhar na Vercel, fazer o Worker só da ponte (pedir OK antes de criar qualquer recurso na
   Cloudflare).

## Fontes (consultadas em 18/10/2026)

- Vercel: https://vercel.com/docs/limits/fair-use-guidelines, https://vercel.com/pricing, https://vercel.com/docs/plans/hobby,
  https://vercel.com/docs/plans/pro-plan, https://vercel.com/docs/functions/limitations,
  https://vercel.com/docs/functions/usage-and-pricing, https://vercel.com/docs/cron-jobs/usage-and-pricing,
  https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections
- Cloudflare: https://developers.cloudflare.com/workers/platform/limits/, https://developers.cloudflare.com/workers/platform/pricing/,
  https://developers.cloudflare.com/workers/configuration/cron-triggers/, https://developers.cloudflare.com/workers/runtime-apis/nodejs/,
  https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/, https://developers.cloudflare.com/workers/tutorials/deploy-an-express-app/,
  https://developers.cloudflare.com/workers/runtime-apis/websockets/, https://developers.cloudflare.com/workers/static-assets/,
  https://developers.cloudflare.com/hyperdrive/platform/pricing/,
  https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/supabase/,
  https://developers.cloudflare.com/r2/pricing/
- Prisma: https://www.prisma.io/docs/guides/v7/deployment/cloudflare-workers, https://www.prisma.io/changelog/2025-09-10
- Supabase: https://supabase.com/pricing, https://supabase.com/docs/guides/platform/free-plan-pausing
- Câmbio: PTAX de venda do Banco Central (olinda.bcb.gov.br), 01–16/10/2026.

Não confirmado: plano atual do Supabase; uso mensal real da Vercel; se as queries via Hyperdrive contam como subrequest; duração
máxima de WebSocket na Cloudflare; se o WebSocket em beta da Vercel funciona com `builds`/`routes`.

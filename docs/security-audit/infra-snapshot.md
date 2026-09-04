# Estado da infraestrutura — snapshot em 2026-08-21

Ponto de partida confirmado diretamente via MCP Supabase, MCP Vercel e `vercel` CLI
(linkado nesta sessão) — referência histórica, não atualizar retroativamente.

## Supabase

- Projeto: `wgpoxmbpkgrcmfxgkdss` (`https://wgpoxmbpkgrcmfxgkdss.supabase.co`).
- 14 tabelas em `public`, RLS **ligado** em todas, **zero policies** em todas
  (confirmado via `get_advisors(type=security)`).
- Role de conexão do Prisma (`postgres`, usado pela `DATABASE_URL`) tem
  `rolbypassrls = true` (confirmado via SQL direto) — RLS é decorativo hoje, ver
  achado #6 em `findings.md`.
- Migrations aplicadas (5): `crm_topconta_init`, `enable_rls_all_tables`,
  `add_user_security_fields`, `add_card_account_fields_to_client`,
  `add_saldo_cartao_fields_to_client`.
- Dados reais no momento da auditoria: 370 `Client`, 17 `AuditLog`, 3 `ImportJob`, 1
  `SheetConnection`, 0 `ChannelConfig` (nenhum canal de WhatsApp/SMS configurado
  ainda), 1 `Tenant`, 1 `User`.
- `get_advisors(type=performance)`: achados menores (FKs sem índice de cobertura,
  2 índices nunca usados) — não tratados nesta rodada de segurança, candidatos a
  uma passada de performance separada.

## Vercel

- Team: `topcontamkt-4608s-projects` (`team_VlmbsdXuniw3sIr8gMg8Wrbl`).
- Projetos: `crmtopconta-backend` (`prj_7WuiR0AxczbeOyh800o6hEgBaxKC`, framework
  `express`), `crmtopconta-frontend` (`prj_kXOzihBTuDLxV1ie9goGDy4IE56O`, framework
  `vite`). Ambos com deploy de produção `READY` no início da auditoria.
- Deployment protection (SSO/senha/IP): **desligada** nos dois projetos — esperado,
  o perímetro de auth é 100% da aplicação (JWT).
- `get_runtime_errors` (janela de 7 dias) no backend: 4 clusters de erro
  encontrados, todos **já resolvidos por deploys anteriores a esta auditoria**:
  - `PrismaClientUnknownRequestError`/`PrismaClientRustPanicError` (falhas de
    prepared statement no pooler PgBouncer, 190 ocorrências) — corrigido pelo commit
    `ea85209` (`pgbouncer=true&connection_limit=1` na `DATABASE_URL` de runtime),
    deployado em 2026-08-20T14:01Z.
  - `Vercel Runtime Timeout Error` (6 ocorrências, imports grandes estourando os
    300s) — corrigido pelo commit `82214bf` (upload em lotes de 150 linhas),
    deployado em 2026-08-21T01:19Z, ~2min após a última ocorrência registrada.
  - `NotFoundError` (1 ocorrência isolada, "No Tenant found" em `routes/tenant.js`)
    — histórica, mesma leva pré-fix do pooler; endpoint agora devolve 404 limpo em
    vez de 500 cru (achado #7).
  - Frontend: nenhum erro de runtime nos últimos 7 dias.

### ⚠️→✅ Variáveis de ambiente de produção — achado crítico descoberto e corrigido durante a auditoria

`vercel env ls production` no backend (via CLI, projeto linkado nesta sessão)
mostrou originalmente exatamente 5 variáveis configuradas, uma delas com o nome
digitado errado:

```
DIRECT_URL                   Hidden   Sensitive   Production, Preview
DATABASE_URL                  Hidden   Sensitive   Production, Preview
CRON_SECRET                   Hidden   Sensitive   Production, Preview
REDENTIALS_ENCRYPTION_KEY     Hidden   Sensitive   Production, Preview   ← nome ERRADO
JWT_SECRET                    Hidden   Sensitive   Production, Preview
```

**`REDENTIALS_ENCRYPTION_KEY` em vez de `CREDENTIALS_ENCRYPTION_KEY`** (falta o "C"
inicial). O código sempre leu (e a nova validação em `config/env.ts` agora exige,
falhando o boot) `process.env.CREDENTIALS_ENCRYPTION_KEY` — essa variável, com o
nome certo, **nunca existiu em produção**. Consequência prática: `services/crypto.ts`
sempre falhou ao cifrar/decifrar credenciais de canal em produção (silenciosamente,
só no momento de uso) — consistente com `ChannelConfig` ter 0 linhas até aqui.

**`ALLOWED_ORIGINS` (novo, achado #3) também não estava setada.**

**Correção aplicada nesta sessão, com aprovação explícita do usuário**, via `vercel`
CLI (linkado aos dois projetos): gerada uma `CREDENTIALS_ENCRYPTION_KEY` nova
(`openssl rand -base64 32` — segura gerar do zero, já que não havia nenhum
`ChannelConfig` cifrado com a chave antiga/inexistente para perder), adicionada em
Production e Preview; `REDENTIALS_ENCRYPTION_KEY` (typo) removida dos dois
ambientes; `ALLOWED_ORIGINS=https://crmtopconta-frontend.vercel.app` adicionada em
Production. Estado final confirmado via `vercel env ls`:

```
# production
ALLOWED_ORIGINS               Hidden   Sensitive   Production
CREDENTIALS_ENCRYPTION_KEY     Hidden   Sensitive   Production
DIRECT_URL                     Hidden   Sensitive   Production, Preview
DATABASE_URL                   Hidden   Sensitive   Production, Preview
CRON_SECRET                    Hidden   Sensitive   Production, Preview
JWT_SECRET                     Hidden   Sensitive   Production, Preview

# preview
CREDENTIALS_ENCRYPTION_KEY     Hidden   Sensitive   Preview
DIRECT_URL                     Hidden   Sensitive   Production, Preview
DATABASE_URL                    Hidden   Sensitive   Production, Preview
CRON_SECRET                     Hidden   Sensitive   Production, Preview
JWT_SECRET                      Hidden   Sensitive   Production, Preview
```

Nota: `ALLOWED_ORIGINS` foi setada só em Production, por escopo explícito da
aprovação — deployments de Preview (branches) ainda vão cair no default de
desenvolvimento até alguém decidir uma allow-list própria para preview, o que é
aceitável (preview não serve tráfego real de clientes).

`WHATSAPP_APP_SECRET`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `WHATSAPP_*`, `TWILIO_*`
também não estão setadas — esperado (nenhum canal configurado ainda: `ChannelConfig`
= 0 linhas; Sheets provavelmente não sincroniza de fato apesar de haver 1
`SheetConnection` salva, já que falta o service account).

## RLS real — atualização pós-auditoria (rodada de finalização)

Aplicado ao Supabase de produção (SQL rodado pelo usuário no SQL Editor, verificado via MCP
logo em seguida): role `app_runtime` (`LOGIN`, `NOBYPASSRLS`) + policy `tenant_isolation`
(`FOR ALL`) nas 14 tabelas, usando `current_setting('app.tenant_id', true)`. Confirmado via
`get_advisors(type=security)` — os 14 lints `rls_enabled_no_policy` que existiam no início da
auditoria (ver seção Supabase acima) zeraram. Role `postgres` (usado por `DATABASE_URL`/
`DIRECT_URL` hoje) continua com `rolbypassrls=true`, inalterado.

**Estado final: ativo em produção (2026-09-04).** `DATABASE_URL` trocada para `app_runtime` e
`DATABASE_URL_ADMIN` (role privilegiado, só para os jobs cross-tenant do scheduler) adicionada
no Vercel do backend, com aprovação explícita do usuário passo a passo. Deploy `d577392`
(commit com todo o código RLS-aware) confirmado `READY`, sem erros de runtime pós-deploy, dados
intactos (1 tenant, 1 user, 370 clients), e login real na aplicação em produção confirmado pelo
usuário — prova de ponta a ponta que o role restrito funciona para tráfego real.

Durante o processo, o usuário rotacionou a senha do role `postgres` (privilegiado) — era uma
senha fraca/padrão descoberta por acaso ao pedir a connection string para montar
`DATABASE_URL_ADMIN`. Isso invalidou temporariamente o `DATABASE_URL`/`DIRECT_URL` então em uso
(mesma senha antiga) — corrigido no mesmo lote de mudanças, sem incidente registrado
(`get_runtime_errors` limpo durante toda a janela da troca).

Implementação completa no código (`backend/src/config/tenantGuard.ts`/`db.ts`,
`middleware/auth.ts`, e o wrapping por-tenant em `services/scheduler.ts`/`automationEngine.ts`/
`retention.ts`/`biExport.ts` para os jobs de cron) já testada e validada localmente contra
Postgres real nesta sessão: login, CRUD normal, os 6 jobs de cron, e um teste explícito de
isolamento cross-tenant via HTTP (usuário de um tenant não vê nada do outro). Ver
`verification-tests.md` para o detalhe completo.

## `npm audit` — antes e depois

| Pacote | Antes | Depois |
|---|---|---|
| Backend (`googleapis` `^140.0.1`→`^176.0.0`, `node-cron` `^3.0.3`→`^4.6.0`) | 5 moderadas (`uuid` <11.1.1, transitivo) | **0 vulnerabilidades** |
| Frontend (`react-router-dom` `^6.26.1`→`^7.18.2`) | 2 moderadas (open redirect + injeção via `deserializeErrors`) | Resolvidas. Restou 1 par moderado/alto pré-existente e não relacionado (`esbuild` ≤0.24.2, via `vite`) — fora do escopo desta correção, exigiria bump de major do Vite separadamente |

Nenhuma mudança de código foi necessária nos dois bumps de major (backend: só
recursos estáveis da API do Sheets v4 e da assinatura básica do `node-cron` foram
usados; frontend: só a API declarativa clássica do `react-router-dom`, nenhuma API
de data router usada em `frontend/src`).

## Testes automatizados — antes e depois

- Backend: 53 testes (7 suítes) antes da auditoria → **85 testes (10 suítes)**
  depois, cobrindo especificamente as correções desta rodada (`env.test.ts`,
  `tenantGuard.test.ts`, `webhookAuth.test.ts`, `rateLimit.test.ts`,
  `retention.test.ts` novo/expandido).
- Frontend: nenhuma suíte de testes existia antes nem foi criada agora (confirmado:
  sem `vitest`/jest/RTL no `package.json`) — verificação das mudanças de frontend
  feita via `tsc -b` + `vite build` bem-sucedidos, consistente com o que
  `CLAUDE.md` já documentava sobre a ausência de testes de frontend no projeto.

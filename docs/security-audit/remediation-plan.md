# Plano de correção — achado por achado

| # | Achado | Correção | Arquivos principais |
|---|---|---|---|
| 1 | `JWT_SECRET` fallback / sem validação de boot | `config/env.ts` novo (zod, falha rápido no import); fallback removido de `auth.ts` | `backend/src/config/env.ts`, `backend/src/middleware/auth.ts`, `backend/src/app.ts` |
| 2 | Webhooks sem assinatura | `services/webhookAuth.ts` novo — verifica `X-Twilio-Signature` (HMAC-SHA1) e `X-Hub-Signature-256` (HMAC-SHA256), `timingSafeEqual` | `backend/src/services/webhookAuth.ts`, `backend/src/routes/integrations.ts`, `backend/src/app.ts` (raw body), `backend/src/types/express.d.ts` |
| 3 | CORS aberto | Allow-list via `ALLOWED_ORIGINS` | `backend/src/app.ts`, `backend/src/config/env.ts`, `backend/.env.example` |
| 4 | Sem headers de segurança | `helmet()` | `backend/src/app.ts`, `backend/package.json` |
| 5 | Sem rate limit | `middleware/rateLimit.ts` novo — 3 limiters (`express-rate-limit`) | `backend/src/middleware/rateLimit.ts`, `backend/src/routes/auth.ts`, `backend/src/routes/integrations.ts`, `backend/src/routes/imports.ts`, `backend/package.json` |
| 6 | RLS decorativo | `config/tenantGuard.ts` novo — extensão Prisma, hard-throw sem `tenantId` | `backend/src/config/tenantGuard.ts`, `backend/src/config/db.ts`, + ajuste de tipo (`AppPrismaClient`) em todos os services que recebem `PrismaClient` como parâmetro |
| 6b | (roadmap) RLS real | Não implementado — registrado como próximo passo | `backend/prisma/schema.prisma` (futura migration de policies), `backend/src/config/db.ts` (troca de role de conexão) |
| 7 | Erro cru vazando | Mensagem genérica na resposta HTTP, log completo só no servidor | `backend/src/routes/imports.ts`, `backend/src/routes/tenant.ts` |
| 8 | PII em AuditLog sobrevive anonimização | (A) `logAudit(...)` redigido em 4 call sites; (B) cascata de redação no sweep de retenção | `backend/src/routes/users.ts`, `backend/src/routes/automations.ts`, `backend/src/routes/campaigns.ts`, `backend/src/routes/clients.ts`, `backend/src/services/retention.ts` |
| 9 | Deps moderadas | Bump de major version + verificação de breaking changes | `backend/package.json` (`googleapis`, `node-cron`), `frontend/package.json` (`react-router-dom`) — ver `infra-snapshot.md` para o resultado final |
| 10 | `/users` e `/audit` sem gate no front | Componente `RoleGate` espelhando os `requireRole` do backend | `frontend/src/App.tsx` |
| 11 | AuditLog não tamper-evident | Hash-chain (SHA-256, `prevHash`/`hash` por linha, cadeia global) + endpoint de verificação | `backend/src/services/auditIntegrity.ts` (novo), `backend/src/middleware/audit.ts`, `backend/src/routes/audit.ts`, `backend/prisma/schema.prisma` |
| 12 | IDOR em rotas por id (`findUnique`/`update`/`delete`/`upsert`) | Auditoria rota-por-rota das 9 arquivos afetados — sem achados, verify-then-act já consistente | `backend/src/routes/{clients,notifications,users,segments,auth,templates,integrations,tenant,automations}.ts` (revisados, não alterados) |

## Novas variáveis de ambiente introduzidas

Todas documentadas com comentário em `backend/.env.example`:

- **`ALLOWED_ORIGINS`** (obrigatória em produção, tem default de dev) — lista de
  origens separadas por vírgula que o CORS deve aceitar. **Precisa ser setada no
  Vercel do backend com a URL real do frontend em produção.**
- **`WHATSAPP_APP_SECRET`** (opcional, mas necessária para fechar o achado #2
  completamente) — Meta App Secret, distinto do `WHATSAPP_WEBHOOK_VERIFY_TOKEN` já
  existente. Sem ela, o endpoint de webhook do WhatsApp continua aceitando
  requisições não verificadas (com warning no log) — comportamento defensivo
  intencional até o secret ser provisionado.

## Novas dependências introduzidas

- `helmet` (backend) — headers de segurança.
- `express-rate-limit` (backend) — rate limiting.
- `supertest` + `@types/supertest` (backend, devDependency) — testes HTTP dos
  novos limiters.

## O que ficou fora do escopo desta rodada (propositalmente)

- **RLS real no Postgres** — em andamento nesta mesma sessão (rodada de finalização,
  ver `docs/security-audit/README.md`), roadmap original em achado #6.
- **`WHATSAPP_APP_SECRET`** — variável nova, ainda não provisionada em produção
  (confirmado via `vercel env ls`); até ser configurada, o webhook do WhatsApp
  aceita requisições sem verificar assinatura (com warning no log). Provisionar via
  Meta App Dashboard → Settings → Basic quando o canal de WhatsApp for ativado —
  fora do alcance desta sessão (requer acesso ao Meta Business Manager do cliente).
- **Backup/PITR do Supabase** — sem tool MCP para checar; usuário confirma
  diretamente no dashboard do Supabase.

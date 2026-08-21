# Checklist de verificação

Marcado ✅ = automatizado e passando agora. Marcado ⏳ = precisa de ação fora do
código (env var em produção) antes de poder ser verificado de ponta a ponta.

## #1 — Validação de env no boot
- ✅ `backend/src/config/env.test.ts` — sobe sem vars obrigatórias setadas → lança
  erro listando exatamente quais faltam; com todas setadas → não lança.
- ✅ **Em produção**: `REDENTIALS_ENCRYPTION_KEY` corrigida para
  `CREDENTIALS_ENCRYPTION_KEY` no Vercel (nova chave gerada, sem dado cifrado
  antigo a migrar) — confirmado via `vercel env ls`, ver `infra-snapshot.md`.

## #2 — Assinatura de webhook
- ✅ `backend/src/services/webhookAuth.test.ts` (15 testes) — assinatura válida,
  ausente, payload adulterado, secret/token errado, header malformado, comparação
  cruzada com HMAC calculado manualmente.
- ⏳ Verificação end-to-end real do WhatsApp precisa de `WHATSAPP_APP_SECRET`
  provisionado em produção (Meta App Dashboard) — até lá, endpoint aceita requisições
  não verificadas com warning no log (comportamento defensivo documentado, não bug).
- Manual (pós-deploy, opcional): `curl -X POST .../webhooks/sms/twilio` sem
  `X-Twilio-Signature` → espera 401.

## #3 — CORS
- ✅ Lógica de allow-list coberta indiretamente pelos testes de `env.ts`
  (`ALLOWED_ORIGINS` parseada corretamente).
- ✅ **Em produção**: `ALLOWED_ORIGINS=https://crmtopconta-frontend.vercel.app`
  setada (ambiente Production) — confirmado via `vercel env ls`. Preview ainda cai
  no default de dev, aceitável (não serve tráfego real).
- Manual (pós-deploy): `curl -H "Origin: https://evil.example" .../api/clients` →
  resposta não deve trazer `Access-Control-Allow-Origin: https://evil.example`;
  requisição com a origem real do frontend deve funcionar normalmente.

## #4 — Helmet
- Manual (pós-deploy): `curl -I` no deploy → confirmar `X-Content-Type-Options`,
  ausência de `X-Powered-By`, headers do helmet presentes.

## #5 — Rate limiting
- ✅ `backend/src/middleware/rateLimit.test.ts` (7 testes) — os 3 limiters aceitam
  requisições até o limite e devolvem 429 na N+1; isolamento por usuário confirmado
  no limiter de imports.
- Nota: store em memória, por instância — em serverless, cada cold start reseta o
  contador (limitação documentada e aceita, ver `findings.md` #5).

## #6 — Guard de tenant (rede de segurança em código)
- ✅ `backend/src/config/tenantGuard.test.ts` (15 testes) — detector recursivo de
  `tenantId` em `AND`/`OR`/`NOT`, hook do guard lançando erro, mecanismo de exceção
  (`withCrossTenantAccess`) e isolamento via `AsyncLocalStorage` entre chamadas
  concorrentes.
- ✅ Suíte completa do backend (85 testes) passou sem precisar afrouxar o guard —
  confirma que todas as queries existentes já filtravam por `tenantId` corretamente,
  exceto uma (`automationEngine.ts`, ação de bloqueio) corrigida durante o processo.
- ⏳ RLS real (roadmap) ainda não implementado — sem teste aplicável ainda.

## #7 — Erro cru vazando
- Manual (pós-deploy): forçar uma falha de import (ex.: `GOOGLE_SERVICE_ACCOUNT_JSON`
  ausente ou planilha malformada) → corpo da resposta HTTP só deve conter a mensagem
  genérica; log do servidor (Vercel runtime logs) deve conter o detalhe completo.
- Manual: acessar `/api/tenant/settings` com um tenant inexistente → 404 limpo, não
  mais 500 cru.

## #8 — PII em AuditLog
- ✅ `backend/src/services/retention.test.ts` (6 testes, novo arquivo) — sweep de
  retenção redige PII em `AuditLog.details` de entradas endereçáveis por
  `targetId` do cliente anonimizado, preserva campos não-PII, não toca em entradas
  de outros clientes, é idempotente em cima de entradas já redigidas.
- Manual (contínuo): revisar periodicamente novos `logAudit(...)` call sites
  adicionados no futuro para confirmar que não voltam a passar `req.body`/PII bruta
  sem allowlist — não há lint automatizado para isso ainda.

## #9 — Dependências
- ✅ `npm audit` limpo no backend (0 vulnerabilidades); frontend sem as
  vulnerabilidades do `react-router` (resta 1 par não relacionado do `esbuild`/
  `vite`, fora de escopo).
- ✅ `tsc --noEmit` + suíte completa (backend) e `tsc -b` + `vite build`
  (frontend) confirmam que os bumps de major não quebraram nada.

## #10 — RoleGate no frontend
- ✅ Revisão manual da lógica do `RoleGate` (sem framework de teste de frontend no
  projeto) — `!allowedRoles.includes(user.role)` redireciona, não invertido.
- ✅ `tsc -b` + `vite build` passam.
- Manual (pós-deploy): logar como OPERATOR/ANALYST/VIEWER, navegar direto para
  `/users` → redirecionado para `/` em vez de renderizar a tela quebrada; ANALYST
  em `/audit` → renderiza normalmente (permitido); OPERATOR/VIEWER em `/audit` →
  redirecionado.

## Verificação geral de ambiente (bloqueante para fechar #1 e #3)
- ✅ `REDENTIALS_ENCRYPTION_KEY` → `CREDENTIALS_ENCRYPTION_KEY` corrigida no Vercel
  do backend (Production + Preview).
- ✅ `ALLOWED_ORIGINS` setada no Vercel do backend (Production) com a URL real do
  frontend.
- ⏳ (Opcional, fecha #2 completamente) Provisionar `WHATSAPP_APP_SECRET`.
- Ambas as correções confirmadas via `vercel env ls production`/`preview` nesta
  sessão — falta apenas o próximo deploy do backend para elas entrarem em efeito
  (variáveis de ambiente no Vercel só são lidas em builds/invocações novas).

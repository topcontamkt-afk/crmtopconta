# 05 · Segurança do tratamento e incidentes

Dispositivos centrais: [art. 46](../../../../docs/lgpd/fontes/lei-13709.md#art-46) (medidas técnicas e
administrativas), [art. 47](../../../../docs/lgpd/fontes/lei-13709.md#art-47) (sigilo de quem intervém no
tratamento), [art. 48](../../../../docs/lgpd/fontes/lei-13709.md#art-48) (comunicação de incidente),
[art. 49](../../../../docs/lgpd/fontes/lei-13709.md#art-49) (sistemas estruturados para segurança),
[art. 6º, VII–VIII](../../../../docs/lgpd/fontes/lei-13709.md#art-6) (segurança, prevenção),
[Res. 15/2024](../../../../docs/lgpd/fontes/anpd-res-15-2024-incidentes.md): prazo de 3 dias úteis à ANPD
([Anexo, art. 6º](../../../../docs/lgpd/fontes/anpd-res-15-2024-incidentes.md#anexo-art-6)) e ao titular
([Anexo, art. 9º](../../../../docs/lgpd/fontes/anpd-res-15-2024-incidentes.md#anexo-art-9)), registro de
todo incidente por 5 anos ([Anexo, art. 10](../../../../docs/lgpd/fontes/anpd-res-15-2024-incidentes.md#anexo-art-10)).

**Não refaça a auditoria de segurança.** Ela foi feita em 2026-08-21 e está em `docs/security-audit/`
(`findings.md`, `remediation-plan.md`). Leia-a primeiro. Nesta dimensão:
(a) confirme que as correções dela **continuam no código** em `HEAD` (o código mudou bastante depois:
+45 commits; procure regressões nos arquivos novos), e
(b) cubra o que é específico da LGPD: capacidade de **detectar, registrar e comunicar** incidente.

## Checklist

| # | Pergunta verificável | Onde olhar |
|---|----------------------|------------|
| 05.1 | Isolamento por tenant: **toda** query Prisma e todo SQL cru em rotas e serviços **novos ou alterados** desde a auditoria filtra por `tenantId`? Liste os arquivos checados. Vazamento entre tenants vira incidente com vários controladores. | `git log --since=2026-08-21 --name-only -- backend/src`, `grep -rn "\$queryRaw\|\$executeRaw\|findMany\|updateMany\|deleteMany" backend/src` |
| 05.2 | Rotas novas (inbox, mídia, purchases, ciclos, dashboard/engajamento, campanhas manuais, tracked links) têm `requireAuth` e `requireRole` coerentes com o dado exposto (VIEWER vendo telefone e renda?) | `backend/src/routes/*.ts`, `backend/src/app.ts` (montagem) |
| 05.3 | Endpoints **sem auth** por desenho (webhooks, tracked links, cron) validam assinatura ou segredo e não devolvem dado pessoal? | `routes/integrations.ts` (webhooks), `services/webhookAuth.ts`, `routes/trackedLinks.ts`, `routes/cron.ts` |
| 05.4 | Credenciais de canal e segredos 2FA continuam cifrados (`services/crypto.ts`); tokens novos (WhatsApp account, Google service account) também? | `services/crypto.ts`, `services/whatsappAccount.ts`, `services/googleSheets.ts`, `schema.prisma` |
| 05.5 | Mídia recebida (`WaMediaBlob`) e servida por `/api/inbox/media/:id` checa tenant e role, e define `Content-Type`/`Content-Disposition` seguros? | `routes/inbox.ts` (~l.246), `services/whatsappMedia.ts` |
| 05.6 | **Detecção**: há sinal de tentativa de acesso indevido (login falho, 403 entre tenants, rate limit) gravado de forma consultável? | `middleware/audit.ts`, `services/authSecurity.ts`, `middleware/rateLimit.ts` |
| 05.7 | **Registro de incidente** (Res. 15, Anexo, art. 10): existe lugar (model, doc, procedimento) para registrar incidente com os campos mínimos, guardado por 5 anos? Se não existe, a correção mínima pode ser um procedimento em `docs/` + model simples. | `grep -rni "incidente\|incident" backend docs` |
| 05.8 | **Comunicação em 3 dias úteis**: o sistema consegue responder rápido "quais titulares e quais dados foram afetados" num incidente (ex.: export indevido por um usuário)? A trilha de `AuditLog` registra exports com escopo (filtros, quantidade) suficiente? | `middleware/audit.ts`, `routes/clients.ts` (export), `routes/campaigns.ts` (report export) |
| 05.9 | Integridade da trilha: a hash chain de `AuditLog` (`services/auditIntegrity.ts`) cobre todos os writers? Algum código grava `AuditLog` fora do middleware sem encadear? | `grep -rn "auditLog.create" backend/src` |
| 05.10 | Sigilo (art. 47): usuários do CRM (inclusive o operador contratado) aceitam termo de confidencialidade? Isso é `fora_do_codigo`, mas registre se o sistema guarda aceite. | `User` model, `pages/Users.tsx` |

Infra (só metadados via MCP, ver SKILL.md): advisors de segurança do Supabase (`get_advisors`
type=security) e proteção de deployment na Vercel. Registre o resultado em `cobertura`.

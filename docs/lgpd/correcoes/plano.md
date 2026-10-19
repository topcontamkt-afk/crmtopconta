# Plano de correções LGPD

Base: `claude/lgpd-adequacao` (código da linha de produção `ae033a0` + correções). Achados em
[`../auditoria/2026-10-18/achados.json`](../auditoria/2026-10-18/achados.json) e
[`../auditoria/2026-10-18-delta/achados.json`](../auditoria/2026-10-18-delta/achados.json). Decisões em
[`../auditoria/2026-10-18/triagem.md`](../auditoria/2026-10-18/triagem.md).

## Regras para quem implementa

1. **Só os arquivos do seu lote.** `schema.prisma` e `backend/prisma/sql/` pertencem ao Lote 0 (já feito).
   Se faltar campo, **não edite o schema**: registre no retorno.
2. Toda correção ganha **teste que prova** o comportamento. Padrão: `*.test.ts` ao lado do arquivo, Prisma
   mockado com `jest.mock("../config/db", ...)` como em `services/retention.test.ts` e
   `middleware/audit.test.ts`. Sempre que possível, confira que o teste **falha** sem a correção.
3. Comentários curtos citando o id do achado (`// LGPD 03-01`), no estilo dos comentários existentes em pt-BR.
4. Toda query nova filtra por `tenantId`. Model novo com `tenantId` precisa estar em
   `TENANT_SCOPED_MODELS` (`src/config/tenantGuard.ts`), o que o Lote 0 já fez.
5. Nada de produção: sem push, sem aplicar SQL, sem MCP de escrita.
6. Ao final: `npx tsc -p tsconfig.json --noEmit` e os testes dos arquivos tocados verdes. Frontend tocado:
   `npx tsc -b`.

## Lote 0: fundação (schema + SQL), feito pelo orquestrador

`backend/prisma/sql/2026-10-lgpd-adequacao.sql` (estrutura, idempotente) e
`backend/prisma/sql/2026-10-lgpd-minimizacao-dados.sql` (limpeza de dados, **destrutiva**, revisar antes).

| Onde | Campo / model | Uso | Achados |
|------|---------------|-----|---------|
| `Tenant` | `baseLegalMarketing String?` (`LEGITIMO_INTERESSE` \| `CONSENTIMENTO`; nulo = envio de marketing bloqueado) | base declarada pelo controlador | 02-01, 03-06 |
| `Tenant` | `liaVersao String?`, `liaAprovadaEm DateTime?` | prova da LIA | 02-01 |
| `Tenant` | `controladorNome String?` (nulo = `name`), `encarregadoNome String?`, `encarregadoContato String?`, `avisoPrivacidadeUrl String?`, `rodapeOptOut String?` | identificação e canal do titular, rodapé | 02-05, 02-07, 03-06, 08-06 |
| `Tenant` | `retentionBasis String?`, `retentionDaysAfterClosure Int?`, `inboxRetentionDays Int?` (nulo = `retentionDays`), `mediaRetentionDays Int @default(90)` | retenção | 04-02, 04-06, 04-07 |
| `Tenant` | `correcaoManualVence Boolean @default(true)` | correção vs. planilha | 03-03 |
| `Client` | `bloqueadoLgpdAt DateTime?` | suspensão do tratamento a pedido | 03-04 |
| `Client` | `camposCorrigidos Json?` (`{ campo: ISODate }`) | trava de correção manual | 03-03 |
| `Campaign` | `baseLegal String?` | base vigente no disparo | 02-01 |
| `Campaign` | `consentimentoOrigem String?`, `consentimentoPor String?`, `consentimentoEm DateTime?` | prova declarada para lista manual com não clientes | 02-01, 02-02 |
| novo `SupressaoTitular` | `tenantId, phoneHash?, docHash?, motivo (OPT_OUT\|ELIMINACAO\|BLOQUEIO), canal?, origem, pedidoId?, createdAt` | supressão por telefone/documento que sobrevive à anonimização e à reimportação | 02-03, 02-06, 03-01 |
| novo `PedidoTitular` | `tenantId, clientId?, telefoneMasked?, tipo, canal, status, descricao?, recebidoEm, prazoEm, respondidoEm?, resposta?, userId?` | registro e prazo (15 dias) de pedidos de titular | 03-05, 03-07 |

Hashes: `phoneHash` = HMAC-SHA256 com `Tenant.cpfSalt` do telefone **canônico** (E.164 brasileiro com o 9º dígito,
ver `canonicalPhone` no Lote 1). `docHash` = o mesmo `cpfHash` usado hoje (`services/masking.ts`).

## Lotes

| Lote | Tema | Achados | Arquivos (exclusivos do lote) |
|------|------|---------|-------------------------------|
| 1 | Supressão e opt-out por telefone, envio | 02-03, 02-04, 02-06, 05-05 | `services/privacy.ts` (novo: `canonicalPhone`, `phoneHash`, `suprimir`, `estaSuprimido`), `services/campaignQueue.ts`, `services/whatsappInbox.ts`, `services/whatsappReply.ts`, `services/whatsappPayload.ts`, `services/manualCampaign.ts`, `services/automationEngine.ts`, `services/channels/sms.ts`, `routes/integrations.ts` (webhook SMS) |
| 2 | Retenção, anonimização e eliminação | 03-01, 04-01, 04-02, 04-04, 04-05, 04-06, 04-08 (parte de código), 01-02 | `services/retention.ts`, `services/importUndo.ts`, `services/scheduler.ts`, `routes/cron.ts`, `services/importService.ts`, `services/cardAccountImport.ts`, `services/dedupe.ts` |
| 3 | Direitos do titular e exposição | 03-02, 03-03, 03-04, 03-05, 01-04, 05-01, 07-03, 07-05 | `routes/clients.ts`, `routes/dashboard.ts`, `routes/inbox.ts`, `services/titular.ts` (novo), `frontend/src/pages/Clients.tsx`, `ClientProfile.tsx`, `Inbox.tsx`, `components/InboxAlerts.tsx` |
| 4 | Base legal, rodapé, config do controlador | 02-01, 02-02, 02-05, 02-07, 02-08, 03-06, 04-07, 01-01, 01-03 | `routes/tenant.ts`, `routes/campaigns.ts`, `services/campaignWizard.ts`, `services/templateVariables.ts`, `services/whatsappTemplates.ts`, `services/whatsappAutoReply.ts`, `services/segments.ts`, `services/opportunities.ts`, `frontend/src/pages/Settings.tsx`, `frontend/src/utils/importFields.ts`, `pages/campaigns/CampaignWizard.tsx` |
| 5 | Trilha, segurança e governança | 05-03, 06-01, 06-02, 08-07, 08-08 | `routes/auth.ts`, `services/authSecurity.ts`, `middleware/audit.ts`, `services/auditIntegrity.ts`, `routes/audit.ts`, `services/googleSheets.ts`, `routes/imports.ts`, `services/whatsappAccount.ts`, `CLAUDE.md` (seção LGPD) |

**Conflitos previstos.**
- O Lote 2 toca `importService.ts`/`cardAccountImport.ts`, que também precisam consultar a supressão do Lote 1. Por isso
  o Lote 2 roda **depois** do Lote 1 e usa `services/privacy.ts` pronto.
- O Lote 4 precisa do rodapé no envio (`campaignQueue.ts`, que é do Lote 1). Por isso ele expõe
  `montarRodape(tenant)` em `templateVariables.ts`, e quem liga a função no envio é o Lote 1 numa segunda passada, ou o
  orquestrador.

Ordem: **Lote 1 ∥ Lote 3 ∥ Lote 5** → **Lote 2 ∥ Lote 4** → integração (rodapé no envio, documentação) →
`/lgpd-check` no diff total → `/lgpd-audit` pós-correção.

## Fora do código (não implementar)

05-04, 05-06, 06-03, 06-04, 08-05 e 08-06, e os contratos. Viram documentos em `docs/lgpd/artefatos/` (rascunhos,
"requer revisão jurídica") e a lista em [`../auditoria/2026-10-18/fora-do-codigo.md`](../auditoria/2026-10-18/fora-do-codigo.md).

# Pendências entre lotes: estado após a integração (2026-10-18)

Todos os lotes (0 a 5) estão integrados em `claude/lgpd-adequacao`. Esta lista guarda o que foi trocado entre lotes, o
que ficou de fora de propósito e o que depende de alguém fora do código.

## Resolvido na integração

| Item | Onde ficou |
|------|------------|
| Importação respeita `camposCorrigidos`, ignora cliente bloqueado, consulta a supressão e nunca religa opt-out | Lote 2 (`cardAccountImport.ts`, `importService.ts`, `dedupe.ts`) |
| Retenção não quebra a cadeia de auditoria (evento encadeado `AUDIT_REDACAO_LGPD`) | Lote 2 (`auditIntegrity.ts`, `retention.ts`) |
| Opt-out manual por telefone; PARAR cria `PedidoTitular` REVOGACAO atendido | Lote 2 (`routes/clients.ts`, `whatsappInbox.ts`) |
| Eliminação do titular (`POST /clients/:id/anonymize`) e liberação de supressão | Lote 2 |
| Telefone mascarado no export do relatório de campanha | Lote 4 (`routes/campaigns.ts`) |
| Rodapé de opt-out no envio (SMS, texto livre, Z-API, teste) | Lote 4 (`campaignQueue.ts`, `templateVariables.ts`) |
| `webhookUrl` do SMS em Configurações | Lote 4 (`Settings.tsx`) |
| Janela de 24h da Z-API na Inbox; 403 por papel auditado; planilha única por tenant; variáveis de credencial global documentadas | integração `f98c4c9` |
| Público de envio exclui bloqueado, encerrado e anonimizado (`ENVIAVEL_WHERE`); dashboard não conta anonimizado nem bloqueado | integração `9fcc163` + Lote 2 (`dashboardMetrics.ts`) |
| Resposta automática da Inbox com o padrão do controlador; automação confere base legal; prévia de retenção = critério do job | integração `9fcc163` |

## Ficou de fora de propósito

- `trust proxy`: a auditoria já lê `x-vercel-forwarded-for`; ligar mudaria o rate limit da app inteira.
- Contagem de segmento (`/segments/preview`) mostra quantos clientes casam com o filtro; quem pode receber é
  conferido no assistente e no envio (`ENVIAVEL_WHERE`).
- `POST /imports/cartoes/preview` não simula supressão nem correção manual; a importação real conta e mostra.
- Templates MARKETING já existentes sem SAIR só voltam a ser editáveis/reenviáveis com rodapé ou botão de saída.

## Decidir depois

- Auditoria de leitura de conversa e download de mídia na Inbox (o polling de 5 s inundaria o AuditLog; precisa de dedupe).
- `requireRole` em `/api/inbox/resumo` (hoje já sem conteúdo).
- Campos de schema sugeridos: `AuditLog.ip`/`userAgent`, `Tenant.avisoInboxMostraConteudo`, prazo de pedido por tenant.
- Credencial Google por tenant (OAuth ou Service Account cifrada) como solução definitiva de 06-02.
- Retenção do log do servidor para tentativas de login com e-mail inexistente (log drain).
- Anonimização por retenção também grava supressão ELIMINACAO (volta por `NOVA_RELACAO` ou liberação manual): confirmar com a controladora.

## Decisão: eliminação x reimportação

A importação bloqueia eliminado só pelo documento. Ele volta sozinho quando a planilha mostra conta aberta depois do
pedido (relação nova); senão fica de fora, contado, e o ADMIN libera com motivo auditado. No envio, ELIMINACAO por
telefone não barra contato com CPF próprio diferente (número reaproveitado); OPT_OUT e BLOQUEIO por telefone continuam
barrando o número. Revisável pela controladora.

## URGENTE: bug de produção encontrado pelo Lote 4

`POST /api/segments` e `/preview` em produção (`ae033a0`): `z.union([groupSchema, filtersSchema])` com `groupSchema` não
estrito transforma os filtros simples da tela (`{ cidade: [...] }`) em `{ operator: "AND" }`, ou seja, a base inteira.
Campanha por segmento salvo pela tela vai para toda a base enviável. Reproduzido com zod; corrigido nesta branch
(`.strict()`). Candidato a hotfix na `dreamy-brown` (decisão do usuário) e a conferir no banco quais segmentos estão salvos
como `{"operator":"AND"}` e quais campanhas os usaram.

## Antes do deploy (operador)

- Aplicar `backend/prisma/sql/2026-10-lgpd-adequacao.sql` antes do deploy (declara `LEGITIMO_INTERESSE` nos tenants
  existentes, senão o envio de marketing para).
- Confirmar em Integrações que o WhatsApp da TopConta está configurado na tela (token cifrado), senão o envio para (06-01).
- Se houver SMS saindo pelas variáveis `TWILIO_*`: definir `PLATFORM_DEFAULT_TENANT_ID` na Vercel ou cadastrar o canal SMS,
  e configurar no provedor a `webhookUrl` que Configurações mostra (06-01, 05-05).
- Validar em ambiente real, sob `app_runtime` + RLS: o bloco `DO $purge$` do `/clients/purge` e o `UPDATE "Purchase"` da
  anonimização (mockados nos testes).
- Preencher Configurações → LGPD (controlador, encarregado, aviso de privacidade).
- Depois do deploy e da confirmação da controladora: `2026-10-lgpd-minimizacao-dados.sql` (destrutivo).
- Legado conhecido: linhas de AuditLog redigidas pela retenção antiga aparecem como CONTEUDO no verificador; `encerradoEm`
  só é confiável a partir do deploy.

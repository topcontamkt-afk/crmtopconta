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
| Pedido do titular perde texto livre e vínculo na eliminação e no "Limpar base"; supressão ELIMINACAO sem id do pedido e só com o dia (art. 12); número reaproveitado fora da anonimização e do relatório; motivo do export fora da URL | `/lgpd-check` `d83470d` |
| Rodada pós-correção (`docs/lgpd/auditoria/2026-10-18-pos`): revogação/oposição atendida vira opt-out (02-09); relatório e eliminação de quem não é cliente pelo telefone, eliminação só "atendida" depois de eliminar (03-09); limite no login, fila de auditoria por tenant e verificador que reconhece bifurcação (05-08); lista de destinatários sem VIEWER e auditada (05-09) | `b92c223` e o commit seguinte |
| Segmento ou regra antiga com filtro de renda é recusado (sem o filtro o público cresceria); template MARKETING pela Inbox exige base legal; e-mail só pode ser apagado; conta reaberta limpa `encerradoEm`; aviso de que consentimento exige prova fora do CRM | `/lgpd-check` (2ª parte) |

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
  O aviso da importação já não diz "o titular pediu". Opção: motivo próprio `RETENCAO` com prazo.
- Compras de cliente anonimizado seguem ligadas ao `clientId` (valor, lojista, mês, juros). Como a controladora tem o
  extrato original, isso é pseudonimização diante dela (art. 12). Opção: apagar as compras quando a eliminação vem de
  pedido do titular, aceitando perder esses usos no histórico do dashboard e das campanhas.
- Base legal da TopConta declarada pelo SQL `2026-10-lgpd-adequacao.sql`, sem autor no AuditLog: pedir a um ADMIN da
  controladora que salve Configurações → LGPD (grava `UPDATE_TENANT_LGPD` encadeado).
- Consentimento como base: hoje só aviso; recusar enquanto não houver registro de aceite por titular é decisão da controladora.
- Template importado da Meta sem botão/rodapé de saída continua enviável (só aviso no assistente).
- Envio de teste (`/campaigns/:id/test`) não confere base legal (vai para números digitados pela equipe).
- Planilha Google: vale quem cadastra primeiro; prova de posse fica para a credencial por tenant (06-02).
- Reduzir `retentionDaysAfterClosure`, `inboxRetentionDays` ou `mediaRetentionDays` não mostra prévia (só o prazo geral).
- Opt-out por SMS e manual não criam `PedidoTitular` (o do WhatsApp cria); 403 `SEM_ACESSO_AREA` não é auditado.
- 01-05: `sexo` e faixa etária só alimentam o card demográfico do dashboard, sem finalidade declarada. Recomendação: parar de
  importar `sexo` e incluí-lo no SQL de minimização (decisão da controladora), ou declarar a finalidade no aviso.
- Parciais da rodada pós-correção que seguem em aberto: lista de ids exportados (05-01), relatório do titular sem
  `ImportChange` e busca por CPF (03-02), 06-04 e 08-07 (ver o relatório). Fechados depois da rodada: `/dashboard/engajamento`
  sem VIEWER (01-04), compras de cliente bloqueado ignoradas (03-04), login certo com IP/User-Agent (05-03).
- Bifurcação da cadeia entre instâncias diferentes da Vercel ainda pode ocorrer (a fila é por processo); o verificador a
  reconhece. Lock no banco (`pg_advisory_xact_lock`) fica para quando houver como testar sob RLS.
- Opt-outs antigos só em `Client.optOutAt` não foram copiados para `SupressaoTitular` (o envio ainda os lê pelo cadastro).

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

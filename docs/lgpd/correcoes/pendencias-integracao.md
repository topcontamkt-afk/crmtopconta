# Pendências entre lotes (rodada 1 → rodada 2 e integração)

Itens que os lotes deixaram para outro dono. Marque ao resolver.

## Para o Lote 2 (retenção, importação)
- [ ] Importação respeita `Client.camposCorrigidos` quando `Tenant.correcaoManualVence` e não atualiza cliente com
  `bloqueadoLgpdAt` (Lote 3). Aviso ao responsável pela planilha: hoje só a tela mostra ao operador.
- [ ] `retention.ts` reescreve `AuditLog.details` ao anonimizar, o que quebra a cadeia de hash (a verificação acusa
  `CONTEUDO`). Precisa de desenho: registrar a redação como evento encadeado, ou hash sobre resumo (Lote 5).
- [ ] O mock de `retention.test.ts` não tem `auditLog.count`; o Lote 5 trocou por `findMany` com `select id`. Manter compatível.

- [ ] Importação e reimportação usam `semSuprimidos`/`estaSuprimido` e `CONTATO_LIBERADO_WHERE` (`services/privacy.ts`);
  anonimização chama `suprimir(..., { motivo: "ELIMINACAO" })` (Lote 1).
- [ ] Opt-out manual em `routes/clients.ts` chama `registrarOptOutTelefone` (Lote 1).

## Para o Lote 4 (campanhas, segmentos)
- [ ] Telefone mascarado em `/campaigns/:id/report/export.csv` e no relatório nominal (`/destinatarios`) (Lote 3, 05-01).
- [ ] `segments.ts` (`buildSegmentWhere`/`ENVIAVEL_WHERE`) exclui `bloqueadoLgpdAt` (Lote 3, 03-04).

- [ ] `Settings.tsx` mostra a `webhookUrl` dos canais SMS; o texto "usando variáveis de ambiente/mock" não vale mais em produção (Lote 1).

## Integração (orquestrador)
- [x] `routes/inbox.ts:185` devolve `janelaAberta: true` para toda conversa Z-API; usar a regra da Meta e desabilitar o
  Composer com janela fechada (Lote 1, 02-06).
- [x] Documentar `ALLOW_GLOBAL_CHANNEL_CREDENTIALS` e `PLATFORM_DEFAULT_TENANT_ID` no `.env.example` e no CLAUDE.md (Lote 1, 06-01).
- [ ] Opt-out automático (`whatsappInbox.ts`) cria `PedidoTitular` tipo REVOGACAO já atendido (Lote 3).
- [ ] `services/dashboardMetrics.ts` e KPIs ainda contam clientes bloqueados (Lote 3).
- [x] Ligar `logAcessoNegado` em `requireRole` (`middleware/auth.ts`) antes do 403 (Lote 5, 05-03).
- [x] ~~`trust proxy`~~: desnecessário para a auditoria, que lê `x-vercel-forwarded-for` primeiro (`origemRequisicao`).
  Ligar mudaria o rate limit da app inteira, fora do escopo LGPD.
- [x] `PUT /sheets` (`routes/integrations.ts`) recusa `sheetId` já ativo em outro tenant e grava o sheetId na auditoria.
  Hoje a proteção é só na leitura (409 para todos), o que deixa um tenant bloquear a sincronização de outro (Lote 5).
- [x] Comentários desatualizados: `config/tenantGuard.ts` (auditIntegrity como cross-tenant) e `schema.prisma`
  (cadeia "GLOBAL" no `AuditLog`); CLAUDE.md e achado #11 de `docs/security-audit/findings.md` (Lote 5).
- [ ] Rodapé de opt-out no envio (`montarRodape` do Lote 4 em `campaignQueue.ts`).
- [ ] `POST /clients/:id/anonymize` com o `anonymizeClient` do Lote 2.
- [ ] 08-07: seção LGPD do CLAUDE.md, README e `docs/llm-wiki/wiki/topics/seguranca-e-lgpd.md`.
- [ ] Conferir `docs/lgpd/artefatos/registro-de-operacoes.md` contra o comportamento final.

## Antes do deploy (operador)
- Confirmar em Integrações que o WhatsApp da TopConta está configurado na tela (token cifrado), senão o envio para (06-01).
- Se houver SMS saindo pelas variáveis `TWILIO_*`: definir `PLATFORM_DEFAULT_TENANT_ID` na Vercel ou cadastrar o canal
  SMS, e configurar no provedor a `webhookUrl` que `GET /channels` devolve (06-01, 05-05).

## Decidir depois (sem dono)
- Auditoria de leitura de conversa e download de mídia na Inbox (polling de 5 s inundaria o AuditLog; precisa de dedupe).
- `requireRole` em `/api/inbox/resumo` (hoje só sem conteúdo).
- Campos de schema sugeridos: `AuditLog.ip`/`userAgent`, `Tenant.avisoInboxMostraConteudo`, prazo de pedido por tenant.
- Credencial Google por tenant (OAuth ou Service Account cifrada) como solução definitiva de 06-02.
- Retenção do log do servidor para tentativas de login com e-mail inexistente (log drain).

## Decisão: eliminação x reimportação (2026-10-18)
Nota de revisão: bloquear a importação por documento OU telefone apagaria para sempre quem volta a ser cliente e quem
herda um celular reaproveitado. Regra adotada (enviada ao Lote 2): a importação bloqueia eliminado só pelo documento;
volta sozinho quando a planilha mostra conta aberta depois do pedido (relação nova); senão fica de fora, contado, e o ADMIN
libera com motivo auditado. No envio, ELIMINACAO por telefone não barra contato com CPF próprio diferente (número
reaproveitado); OPT_OUT e BLOQUEIO por telefone continuam barrando o número. Revisável pela controladora.

## URGENTE: bug de produção encontrado pelo Lote 4 (2026-10-18)
`POST /api/segments` (e `/preview`) em produção (`ae033a0`): `z.union([groupSchema, filtersSchema])` com `groupSchema`
não estrito transforma filtros simples da tela (`{ cidade: [...] }`) em `{ operator: "AND" }`, isto é, a base inteira.
Campanha por segmento salvo pela tela vai para toda a base enviável. Reproduzido com zod. Corrigido nesta branch
(`.strict()`, commit do Lote 4). Candidato a hotfix na `dreamy-brown` (como a PR #6) e a conferir no banco quais
segmentos estão salvos como `{"operator":"AND"}` e quais campanhas os usaram. Decisão do usuário pendente.

## Pendências do Lote 4 para a integração
- Inbox (`routes/inbox.ts`): usar `autoReplyTextOf(account, tenant)` e `autoReplyPadraoDo(tenant)`; PUT auto-reply recusa texto sem SAIR.
- Automação (`executeAction`): checar base legal antes de criar a campanha e gravar `baseLegal`.
- Retenção: exportar o critério de vencidos para `routes/tenant.ts` (`vencidosWhere` copiado hoje).
- KPIs do dashboard e contagem de segmentos ainda contam bloqueados.
- Templates MARKETING existentes sem SAIR não podem ser editados/reenviados até ganharem rodapé ou botão.

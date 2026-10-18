# Pendências entre lotes (rodada 1 → rodada 2 e integração)

Itens que os lotes deixaram para outro dono. Marque ao resolver.

## Para o Lote 2 (retenção, importação)
- [ ] Importação respeita `Client.camposCorrigidos` quando `Tenant.correcaoManualVence` e não atualiza cliente com
  `bloqueadoLgpdAt` (Lote 3). Aviso ao responsável pela planilha: hoje só a tela mostra ao operador.
- [ ] `retention.ts` reescreve `AuditLog.details` ao anonimizar, o que quebra a cadeia de hash (a verificação acusa
  `CONTEUDO`). Precisa de desenho: registrar a redação como evento encadeado, ou hash sobre resumo (Lote 5).
- [ ] O mock de `retention.test.ts` não tem `auditLog.count`; o Lote 5 trocou por `findMany` com `select id`. Manter compatível.

## Para o Lote 4 (campanhas, segmentos)
- [ ] Telefone mascarado em `/campaigns/:id/report/export.csv` e no relatório nominal (`/destinatarios`) (Lote 3, 05-01).
- [ ] `segments.ts` (`buildSegmentWhere`/`ENVIAVEL_WHERE`) exclui `bloqueadoLgpdAt` (Lote 3, 03-04).

## Integração (orquestrador)
- [ ] Opt-out automático (`whatsappInbox.ts`) cria `PedidoTitular` tipo REVOGACAO já atendido (Lote 3).
- [ ] `services/dashboardMetrics.ts` e KPIs ainda contam clientes bloqueados (Lote 3).
- [ ] Ligar `logAcessoNegado` em `requireRole` (`middleware/auth.ts`) antes do 403 (Lote 5, 05-03).
- [ ] `app.set('trust proxy', 1)` em `app.ts` e conferir se o IP real chega pela rewrite da Vercel (Lote 5).
- [ ] `PUT /sheets` (`routes/integrations.ts`) recusa `sheetId` já ativo em outro tenant e grava o sheetId na auditoria.
  Hoje a proteção é só na leitura (409 para todos), o que deixa um tenant bloquear a sincronização de outro (Lote 5).
- [ ] Comentários desatualizados: `config/tenantGuard.ts` (auditIntegrity como cross-tenant) e `schema.prisma`
  (cadeia "GLOBAL" no `AuditLog`); CLAUDE.md e achado #11 de `docs/security-audit/findings.md` (Lote 5).
- [ ] Rodapé de opt-out no envio (`montarRodape` do Lote 4 em `campaignQueue.ts`).
- [ ] `POST /clients/:id/anonymize` com o `anonymizeClient` do Lote 2.
- [ ] 08-07: seção LGPD do CLAUDE.md, README e `docs/llm-wiki/wiki/topics/seguranca-e-lgpd.md`.
- [ ] Conferir `docs/lgpd/artefatos/registro-de-operacoes.md` contra o comportamento final.

## Decidir depois (sem dono)
- Auditoria de leitura de conversa e download de mídia na Inbox (polling de 5 s inundaria o AuditLog; precisa de dedupe).
- `requireRole` em `/api/inbox/resumo` (hoje só sem conteúdo).
- Campos de schema sugeridos: `AuditLog.ip`/`userAgent`, `Tenant.avisoInboxMostraConteudo`, prazo de pedido por tenant.
- Credencial Google por tenant (OAuth ou Service Account cifrada) como solução definitiva de 06-02.
- Retenção do log do servidor para tentativas de login com e-mail inexistente (log drain).

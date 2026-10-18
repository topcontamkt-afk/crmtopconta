# 04 · Retenção, término do tratamento e eliminação

Dispositivos centrais: [art. 15](../../../../docs/lgpd/fontes/lei-13709.md#art-15) (término: finalidade
alcançada, fim do período, comunicação do titular, determinação da ANPD),
[art. 16](../../../../docs/lgpd/fontes/lei-13709.md#art-16) (eliminação após o término; conservação só
para obrigação legal, pesquisa, transferência a terceiro ou uso exclusivo do controlador
**anonimizado**), [art. 5º, III e XI](../../../../docs/lgpd/fontes/lei-13709.md#art-5) (dado anonimizado e
anonimização), [art. 12](../../../../docs/lgpd/fontes/lei-13709.md#art-12) (anonimizado deixa de ser
pessoal só se a reversão não for possível com esforços razoáveis),
[art. 6º, III](../../../../docs/lgpd/fontes/lei-13709.md#art-6).

Pergunta-guia: **depois que o prazo de retenção do tenant passa, sobra em algum lugar algo que
identifique o titular?**

## Checklist

| # | Pergunta verificável | Onde olhar |
|---|----------------------|------------|
| 04.1 | Liste **todos** os models com dado pessoal (direto ou por `clientId`/telefone) e marque se `retention.ts` os trata. Esperado, no mínimo: `Client` (todos os campos pessoais, inclusive `email`, `externalId`, `dataNascimento`, `sexo`, renda, `empresaConveniada`, `lotacao`, `razaoSocial`, encerramento), `CampaignRecipient`, `Conversation` (`waId`, `contactName`, `lastPreview`), `WaMessage.body`, `WaMediaBlob`, `Purchase`, `Movement`, `AccountSnapshot`, `ImportChange.before`, `ImportJob.errors`, `MessageEvent`, `Notification.message`, `AuditLog.details`, `TrackedLink`/cliques. | `backend/src/services/retention.ts`, `backend/prisma/schema.prisma`, `backend/prisma/sql/*.sql` |
| 04.2 | A anonimização é **irreversível** (art. 12)? Sobrar `externalId`, `cpfHash` com salt do tenant ainda disponível, e-mail, ou combinações (data de nascimento + cidade + empregador) permite reidentificar. | `services/retention.ts`, `services/masking.ts` |
| 04.3 | O critério "inativo há X dias" está bem definido? Qual data é usada (`updatedAt`? última compra? última mensagem?) e uma **reimportação** da planilha "reativa" o cliente e adia a retenção para sempre? | `services/retention.ts`, `services/importService.ts` |
| 04.4 | Cliente com **conta encerrada** (`encerradoEm`) entra na retenção a partir do encerramento (término da relação, art. 15, I) ou continua tratado como inativo comum? | `services/cardAccountImport.ts`, `services/retention.ts` |
| 04.5 | `ImportChange` (histórico para desfazer importação) tem **expiração** de fato? A documentação fala em 30 dias; existe job? | `services/importUndo.ts`, `services/scheduler.ts`, `routes/cron.ts` |
| 04.6 | Mídia do WhatsApp (`WaMediaBlob`) e mensagens da inbox têm prazo próprio? | `services/whatsappMedia.ts`, `services/whatsappInbox.ts` |
| 04.7 | O job de retenção **roda em produção**? Verifique o cron em `backend/vercel.json` e `routes/cron.ts`, e, via MCP Vercel (só leitura), se houve execução recente de `/api/cron/retention` sem erro. Sem acesso: `nao_verificavel`. | `backend/vercel.json`, `routes/cron.ts`; MCP Vercel `get_runtime_logs` filtrando o path |
| 04.8 | `Tenant.retentionDays` (default 1095) é configurável por tenant, tem limite mínimo e máximo, e a mudança é auditada? O valor tem justificativa registrada (obrigação legal, prazo prescricional)? A justificativa é `decisao_negocio`. | `schema.prisma` (`Tenant`), `routes/tenant.ts` |
| 04.9 | Backups e cópias fora do banco: exports CSV gerados ficam guardados em algum lugar (blob, disco)? Planilha de BI no Google recebe dado pessoal (que então escapa da retenção)? | `routes/clients.ts` (export), `routes/campaigns.ts` (report export), `services/biExport.ts` |
| 04.10 | O purge total (`/clients/purge`) e a retenção apagam **em cascata** ou deixam órfãos com dado pessoal (`MessageEvent` com telefone, `Conversation` sem `Client`)? | `schema.prisma` (`onDelete`), `routes/clients.ts` |

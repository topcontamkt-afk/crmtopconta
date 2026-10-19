# 07 · Vazamento de dado pessoal (logs, console, exports, URLs, erros, armazenamento do navegador)

Dispositivos centrais: [art. 46](../../../../docs/lgpd/fontes/lei-13709.md#art-46) (proteger contra acesso
não autorizado e "qualquer forma de tratamento inadequado"),
[art. 6º, III, VII e VIII](../../../../docs/lgpd/fontes/lei-13709.md#art-6) (necessidade, segurança,
prevenção), [art. 49](../../../../docs/lgpd/fontes/lei-13709.md#art-49).

Pergunta-guia: **o dado pessoal sai do banco por algum caminho que não é a tela autorizada?** Log de
servidor (Vercel guarda e mostra para quem tem acesso ao projeto), console do navegador, arquivo
exportado, URL (histórico, analytics, logs de proxy), mensagem de erro, `localStorage`.

## Checklist

| # | Pergunta verificável | Onde olhar |
|---|----------------------|------------|
| 07.1 | Todo `console.log/info/warn/error` do backend: o argumento pode conter dado pessoal? Atenção a objetos inteiros (`err`, `req.body`, `payload`, `row`, `client`): erro do Prisma inclui os **valores** da query; erro do axios inclui `config.data` (corpo enviado à Meta/Twilio, com telefone e texto). | `grep -rn "console\.\(log\|info\|warn\|error\)" backend/src`; `backend/src/app.ts` (handler global ~l.103), `routes/integrations.ts` (~l.376–421), `services/scheduler.ts`, `services/automationEngine.ts`, `routes/imports.ts`, `routes/trackedLinks.ts` |
| 07.2 | Logs reais de produção: via MCP Vercel `get_runtime_logs` (só leitura, últimos dias), há telefone, nome, CPF, e-mail ou corpo de mensagem nas linhas? **Não copie o valor**: descreva o padrão e mascare. Sem acesso: `nao_verificavel`. | MCP Vercel |
| 07.3 | Mensagens de erro devolvidas ao cliente HTTP repetem a entrada (ex.: "telefone +55... inválido")? Erros de importação (`ImportJob.errors`) guardam a linha com dado pessoal? | `app.ts`, `services/importService.ts` (~l.259), `routes/imports.ts` |
| 07.4 | `AuditLog.details`: guarda dado pessoal em claro (e-mail, lista de clientIds com nomes, resultado completo de importação com linhas com erro)? Audit é retido por mais tempo que o dado, então PII nele escapa da retenção. | `middleware/audit.ts`, `routes/imports.ts`, `routes/users.ts`, `routes/clients.ts` |
| 07.5 | **Exports**: `GET /api/clients/export.csv` e o report de campanha levam telefone **em claro**. Quem pode exportar (role)? O export é auditado com escopo? Há limite? Telefone mascarado por padrão, com versão completa só para role específico e motivo? | `routes/clients.ts` (~l.45), `routes/campaigns.ts` (~l.617), `services/csv*`/escape |
| 07.6 | **Exposição na API**: `GET /api/clients` e `/:id` devolvem todos os campos (renda, nascimento, e-mail) a qualquer role autenticado, inclusive VIEWER? A lista de aniversariantes (`/api/dashboard/engajamento`) expõe telefone? | `routes/clients.ts`, `routes/dashboard.ts` (~l.234–294), `middleware/auth.ts` |
| 07.7 | **URLs**: algum dado pessoal vai em path ou query string (telefone, CPF, nome em busca via GET)? Isso aparece em log de acesso e analytics. | `grep -rn "req.query" backend/src/routes`, `frontend/src/api/*.ts` |
| 07.8 | **Navegador**: `localStorage` guarda JWT e usuário (nome, e-mail). Algum dado de **cliente** vai para `localStorage`/`sessionStorage`/IndexedDB (cache de lista, rascunho de campanha com planilha)? Planilha da campanha manual lida no navegador fica em memória ou em storage? | `grep -rn "localStorage\|sessionStorage\|indexedDB" frontend/src`, `components/campaign/PlanilhaAudience.tsx` |
| 07.9 | **Frontend console**: há `console.*` com dado? Erros não tratados mostram resposta crua? | `grep -rn "console\." frontend/src` |
| 07.10 | **Tela**: telefone e e-mail aparecem sem máscara onde não precisam (listas)? A máscara de telefone já existe em `services/masking.ts` (usada na inbox): está sendo aplicada de forma consistente? | `frontend/src/pages/Clients.tsx` (~l.106), `ClientProfile.tsx`, `routes/inbox.ts` (~l.77) |
| 07.11 | Seeds, fixtures e testes: há **dado real** (telefone, CPF ou nome verossímil de pessoa real) commitado? Planilhas de exemplo no repo? | `backend/prisma/seed*`, `**/*.test.ts`, `git ls-files '*.csv' '*.xlsx'` |
| 07.12 | Ferramentas de terceiro no frontend (Speed Insights) capturam conteúdo de tela ou URL com PII? (complementa 06.3) | `frontend/src/main.tsx` |

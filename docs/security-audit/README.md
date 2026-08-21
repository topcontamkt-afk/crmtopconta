# Auditoria de segurança e hardening de produção — CRM TopConta

Diagnóstico completo da infraestrutura viva (Vercel + Supabase) e das correções
aplicadas para deixar o sistema pronto para produção, feito em 2026-08-21 sobre uma
instância já em produção real (Supabase `wgpoxmbpkgrcmfxgkdss`, ~370 clientes reais,
dados protegidos por LGPD).

## Como ler este diretório

- **[findings.md](./findings.md)** — a lista completa de achados, por severidade, com
  status atual (corrigido / risco aceito / roadmap). Comece por aqui.
- **[remediation-plan.md](./remediation-plan.md)** — cada achado mapeado para a
  correção aplicada, arquivo por arquivo.
- **[verification-tests.md](./verification-tests.md)** — como provar que cada
  correção funciona, como checklist.
- **[infra-snapshot.md](./infra-snapshot.md)** — o estado da infraestrutura no
  momento da auditoria (projetos Vercel, projeto Supabase, migrations, `npm audit`),
  como referência histórica do ponto de partida.

## Metodologia

1. **Mapeamento** — inventário das capacidades disponíveis via MCP do Supabase
   (`get_advisors`, `list_tables`, `execute_sql`, `list_migrations`, `list_extensions`)
   e do Vercel (`get_project`, `get_project_deployment_protection`,
   `get_runtime_errors`, `list_deployments`), e das skills já instaladas
   (`security-review`, `security-and-hardening`, `supabase-postgres-best-practices`,
   `supabase`, `vercel-cli`, `postgresql`, `database-migrations-sql-migrations`) —
   nenhuma skill nova precisou ser instalada.
2. **Diagnóstico** — 3 subagents em paralelo revisaram, com leitura completa dos
   arquivos relevantes: superfície de perímetro do backend (CORS, headers, rate
   limit, webhooks, validação de env, dependências), criptografia/LGPD/superfície de
   injeção (envelope encryption, hash de CPF, cascata de retenção, tamper-evidence do
   audit log, SQL cru), e superfície de autenticação/segredos do frontend
   (armazenamento de token, XSS, segredos no bundle, gate de rotas por role).
   Complementado por leitura direta do Supabase (advisors de segurança/performance,
   verificação do role de conexão do Prisma) e do Vercel (erros de runtime dos
   últimos 7 dias, configuração de proteção de deployment) e por `npm audit` nos dois
   pacotes.
3. **Decisão de arquitetura** — o único ponto com mais de uma abordagem válida (RLS
   decorativo vs. rede de segurança em código vs. RLS real) foi levado ao usuário via
   pergunta direta antes de qualquer código ser alterado; decisão: implementar a
   rede de segurança em código agora, registrar RLS real como item de roadmap.
4. **Correção** — implementada em lotes de até 3 subagents em paralelo, cada lote
   verificado com `tsc --noEmit` + suíte de testes completa antes de avançar para o
   próximo.
5. **Verificação** — cada correção tem um teste automatizado específico provando que
   ela funciona (não apenas que o código compila) — ver
   [verification-tests.md](./verification-tests.md).

## Resultado em números

- 11 achados catalogados (2 críticos, 5 altos, 4 médios/baixos).
- 1 achado adicional descoberto e corrigido durante a implementação (uma
  `updateMany` sem filtro de `tenantId` na automação de bloqueio de clientes).
- 2 clusters de erro em produção investigados via `get_runtime_errors` — confirmados
  como já resolvidos por deploys anteriores a esta auditoria (não são achados novos).
- ~85 testes automatizados no backend após as correções (partindo de 53 antes desta
  auditoria), cobrindo especificamente os pontos corrigidos.

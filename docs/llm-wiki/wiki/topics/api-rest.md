---
tags: [API, REST, endpoints, backend]
created: 2026-09-10
updated: 2026-09-10
sources: [repository-analysis.md]
---

# API REST

> A API Express organiza endpoints por domínio e aplica autenticação, papel, tenant guard e auditoria conforme o risco.

## Catálogo por domínio

| Domínio | Endpoints principais |
|---|---|
| Auth | `POST /api/auth/login`, `POST /api/auth/2fa/verify`, `GET /api/auth/me`, troca de senha e gestão de 2FA. |
| Clientes | `GET /api/clients`, detalhe, `PATCH`, bulk e exportação CSV. |
| Dashboard | summary, uso mensal, encerramentos, engajamento, perfil e evolução. |
| Imports | listagem, qualidade, Sheets, CSV, cartões e correção de erros. |
| Segments | listagem, preview, criação, refresh e exclusão. |
| Campaigns | CRUD, audiência, schedule, dispatch, test-send, report e exportação. |
| Automations | listagem, criação e atualização de regras. |
| Integrations | Sheets, canais, exportação BI e webhooks. |
| Audit | consulta de logs e verificação de integridade. |
| Users | listagem, criação, atualização e reset de senha. |
| Templates | CRUD e preview. |
| Notifications | listagem, leitura individual e leitura em massa. |
| Tenant | leitura e alteração de configurações do tenant. |
| Cron | endpoints protegidos para jobs periódicos. |

## Política de requisições

Rotas autenticadas recebem o usuário e o `tenantId` derivados do JWT. Middleware de papel restringe operações administrativas e de exportação. Ações sensíveis passam por auditoria. Login, 2FA, importações e webhooks possuem rate limits específicos.

## Contratos ainda a formalizar

O código é a fonte atual dos contratos detalhados de body, response e códigos de erro. Recomenda-se gerar uma especificação OpenAPI para complementar este catálogo sem duplicar regras de negócio.

## Relações

- [[wiki/topics/arquitetura-do-sistema.md]]
- [[wiki/topics/seguranca-e-lgpd.md]]
- [[wiki/topics/campanhas-e-mensageria.md]]

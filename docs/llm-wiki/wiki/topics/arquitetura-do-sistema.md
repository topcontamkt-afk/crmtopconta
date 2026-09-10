---
tags: [arquitetura, backend, frontend, deploy]
created: 2026-09-10
updated: 2026-09-10
sources: [repository-analysis.md]
---

# Arquitetura do sistema

> Dois pacotes independentes formam uma SPA React e uma API Express multi-tenant.

## Diagrama de containers

```mermaid
flowchart LR
  Browser[ navegador ] --> Front[ frontend React/Vite ]
  Front -->|/api por proxy ou rewrite| API[ backend Express ]
  API --> Prisma[ Prisma Client ]
  Prisma --> DB[(PostgreSQL)]
  API --> Sheets[ Google Sheets ]
  API --> WA[ WhatsApp Cloud API ]
  API --> SMS[ provedores SMS ]
  Cron[ Vercel Cron ou node-cron ] --> API
```

## Entradas

`src/app.ts` configura o app sem efeitos de processo. `src/index.ts` inicia o servidor local e scheduler. `api/index.ts` reexporta o app para Vercel. Essa separação evita iniciar cron em cada invocação serverless.

## Fronteiras

- UI: navegação, formulários, visualizações e estado de sessão.
- API: autenticação, autorização, validação, efeitos e contratos HTTP.
- Serviços: regras de negócio e integrações.
- Prisma/PostgreSQL: persistência, histórico e fila inicial.

## Decisão de hospedagem

Produção usa dois projetos Vercel e Supabase PostgreSQL. O frontend mantém chamadas relativas `/api`; a reescrita aponta para o backend. Variáveis operacionais devem permanecer somente no provedor e em arquivos locais ignorados.

## Relações

- [[wiki/topics/modelo-de-dominio.md]]
- [[wiki/topics/operacao-e-deploy.md]]
- [[wiki/topics/seguranca-e-lgpd.md]]

---
tags: [repositório, arquitetura, CRM, documentação]
created: 2026-09-10
updated: 2026-09-10
sources: [repository-analysis.md]
---

# Inventário técnico do repositório

> Fonte consolidada para a documentação do CRM TopConta.

## Resumo

O repositório implementa um CRM comercial multi-tenant que importa clientes, calcula indicadores de uso, segmenta a base, dispara campanhas por WhatsApp/SMS e registra auditoria e controles LGPD.

## Descobertas principais

- Backend e frontend são pacotes npm independentes.
- A API é Express/TypeScript com Prisma e PostgreSQL.
- A SPA é React/TypeScript com Vite.
- O runtime local usa Express persistente e `node-cron`; o deploy usa funções Vercel e cron HTTP.
- A fila inicial de mensagens é modelada por `MessageEvent` no Postgres.
- CPF/CNPJ são protegidos por hash HMAC por tenant e máscara de exibição.
- Integrações de canal usam adaptadores, incluindo mocks para desenvolvimento.

## Páginas relacionadas

- [[wiki/topics/arquitetura-do-sistema.md]]
- [[wiki/topics/modelo-de-dominio.md]]
- [[wiki/topics/seguranca-e-lgpd.md]]
- [[wiki/topics/pipeline-de-importacao.md]]
- [[wiki/topics/campanhas-e-mensageria.md]]
- [[wiki/topics/segmentacao-e-automacoes.md]]
- [[wiki/topics/api-rest.md]]
- [[wiki/topics/testes-e-qualidade.md]]
- [[wiki/topics/operacao-e-deploy.md]]
- [[wiki/topics/operacao-e-deploy.md]]

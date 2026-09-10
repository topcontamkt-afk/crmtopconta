---
tags: [operação, Vercel, Supabase, desenvolvimento]
created: 2026-09-10
updated: 2026-09-10
sources: [repository-analysis.md]
---

# Operação e deploy

> O fluxo local é persistente; o fluxo de produção é serverless e depende de cron HTTP.

## Desenvolvimento local

```bash
docker compose up -d
cd backend
npm install
npx prisma migrate dev --name init
npm run prisma:seed
npm run dev
```

Em outro terminal:

```bash
cd frontend
npm install
npm run dev
```

O seed é exclusivamente de desenvolvimento. Credenciais de demonstração nunca devem ser promovidas para produção.

## Produção

1. Backend: projeto Vercel com root `backend`, função `api/index.ts` e rotas explícitas.
2. Frontend: projeto Vercel com root `frontend`, build Vite e fallback SPA.
3. Banco: Supabase PostgreSQL.
4. Schema: SQL gerado a partir do Prisma e aplicado conforme o procedimento operacional do ambiente.
5. Cron: endpoints protegidos por segredo de cron.

## Diferenças importantes

| Aspecto | Local | Produção |
|---|---|---|
| Backend | processo Express | função serverless |
| Scheduler | `node-cron` | Vercel Cron |
| Banco | PostgreSQL Docker | Supabase PostgreSQL |
| Frontend | Vite dev server | Vercel static |
| Cron frequente | minutos/horas | limitado pelo plano |
| Sessão de processo | persistente | efêmera |

## Verificação

```bash
cd backend && npm run build && npm test
cd frontend && npm run build
```

Não executar conexão direta a banco apenas para documentação. Validações de ambiente real devem ocorrer pelo procedimento autorizado do responsável pela infraestrutura.

## Relações

- [[wiki/topics/arquitetura-do-sistema.md]]
- [[wiki/topics/seguranca-e-lgpd.md]]

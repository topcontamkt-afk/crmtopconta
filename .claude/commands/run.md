---
description: Sobe o CRM TopConta localmente (Postgres, backend, frontend) para desenvolvimento
---

Prepare e suba o ambiente de desenvolvimento local completo do CRM TopConta: Postgres via
docker compose (porta 5432), backend Express+Prisma (porta 4000), frontend Vite (porta 5173).

Verifique o estado real do sistema a cada passo abaixo — não assuma que nada já está pronto
nem que nada mudou desde a última vez. Rode os passos que já estão satisfeitos como no-op
(idempotente); só faça o que realmente falta.

## 1. Postgres local

Confira se o container já está de pé: `docker ps --filter name=crmtopconta-postgres --format
"{{.Names}} {{.Status}}"`. Se não aparecer nada, suba com `docker compose up -d` a partir da
raiz do repositório (o `docker-compose.yml` está lá, não em `backend/`).

## 2. `backend/.env`

Se `backend/.env` não existir, crie a partir de `backend/.env.example`, mas gerando valores
reais para os secrets obrigatórios em vez de deixá-los vazios (o backend falha no boot sem
eles, ver `backend/src/config/env.ts`):

```bash
JWT_SECRET=$(openssl rand -base64 32)
CREDENTIALS_ENCRYPTION_KEY=$(openssl rand -base64 32)
CRON_SECRET=$(openssl rand -base64 32)
```

`ALLOWED_ORIGINS="http://localhost:5173"` (já é o default do próprio `config/env.ts` se
omitido, mas deixe explícito no arquivo). `DATABASE_URL`/`DIRECT_URL` continuam apontando
para o Postgres local do docker-compose (usuário/senha/db `crmtopconta`, ver comentário no
`.env.example`). Deixe `GOOGLE_SERVICE_ACCOUNT_JSON`, `WHATSAPP_*`, `WHATSAPP_APP_SECRET` e
`TWILIO_*` em branco — são opcionais em dev (sem eles, as integrações reais ficam
indisponíveis mas o resto do app funciona normalmente; campanhas usam o adapter mock).

Se `backend/.env` já existir, não sobrescreva — apenas avise se alguma variável obrigatória
(`DATABASE_URL`, `JWT_SECRET`, `CREDENTIALS_ENCRYPTION_KEY`) estiver vazia ou ausente.

## 3. Dependências

Cheque se `backend/node_modules` e `frontend/node_modules` existem; se não, rode `npm install`
em cada um.

## 4. Schema do banco

Este repositório **não versiona uma pasta `prisma/migrations`** — o fluxo documentado em
`CLAUDE.md` aplica mudanças de schema direto no Supabase em produção via
`prisma migrate diff --from-empty --to-schema-datamodel ... --script`, nunca `prisma migrate
dev`/`deploy`. Para o Postgres local, use sempre:

```bash
cd backend && npx prisma generate && npx prisma db push
```

`db push` sincroniza `prisma/schema.prisma` direto no banco local sem exigir migrations —
seguro para reaplicar a qualquer momento (idempotente).

## 5. Seed (se o banco estiver vazio)

Confira se já existe algum `Client`/`Tenant` (`docker exec <container> psql -U crmtopconta -d
crmtopconta -c "select count(*) from \"Client\";"` ou equivalente). Se a tabela estiver vazia
ou não existir ainda, rode `npm run prisma:seed` (a partir de `backend/`) — cria um tenant
demo, os 3 usuários demo (`admin@topconta.demo` / `operador@topconta.demo` /
`analista@topconta.demo`, senha `mudar123`) e clientes de exemplo.

## 6. Subir os servidores

Inicie os dois em background (eles são processos de longa duração, não vão terminar
sozinhos):

```bash
cd backend && npm run dev    # ts-node-dev --respawn, porta 4000, recarrega sozinho ao salvar
cd frontend && npm run dev   # vite, porta 5173, HMR
```

Redirecione a saída de cada um para um arquivo de log (ex.: no diretório de scratchpad da
sessão) em vez de deixar preso no terminal, e use a opção de rodar em background da sua
ferramenta de shell. Espere alguns segundos e confirme:

```bash
curl -s http://localhost:4000/health   # espera {"status":"ok"}
curl -sI http://localhost:5173         # espera HTTP 200
```

Se o backend não subir, leia o log — o motivo mais comum é uma env var obrigatória vazia
(volte ao passo 2) ou o Postgres não estar acessível (volte ao passo 1).

## 7. Reportar ao usuário

Ao final, informe: URLs (`http://localhost:5173` frontend, `http://localhost:4000` API),
credenciais de login demo, e onde estão os arquivos de log de cada servidor (para tail
manual se precisar depurar algo). Lembre que `ENABLE_SCHEDULER=true` no `.env` faz os jobs
periódicos (sync de planilha, automações, dispatch de campanha, etc. — ver
`backend/src/services/scheduler.ts`) rodarem em processo a cada 1-5min automaticamente
enquanto o backend estiver de pé localmente.

## Se algo já estiver rodando

Antes de tentar subir de novo, cheque se as portas 4000/5173 já estão em uso
(`lsof -i :4000`, `lsof -i :5173`, ou `curl` direto nos health checks) — não duplique
processos. Se precisar reiniciar do zero, pare os processos existentes antes.

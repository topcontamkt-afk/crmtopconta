---
description: Checklist de pré-deploy do CRM TopConta — testes, build, deps, env vars do Vercel e schema do Supabase
---

Rode a checklist completa abaixo ANTES de qualquer deploy de produção do CRM TopConta
(backend `crmtopconta-backend` + frontend `crmtopconta-frontend`, ambos na Vercel, banco
Supabase). Isto é um checklist de verificação, não um script de deploy automático — reporte
o resultado de cada item (✅/⚠️/❌) e só sugira o comando de deploy em si no final, pedindo
confirmação explícita antes de rodá-lo (deploy em produção é uma ação que afeta usuários
reais, nunca dispare sem o usuário aprovar naquele momento especificamente).

## 1. Estado do git

`git status` e `git log` no branch atual — confirme que não há mudanças não commitadas
relevantes, que o branch é o esperado, e reveja os commits desde o último deploy de produção
(`git log <último deploy>..HEAD --oneline` se souber o SHA, ou os commits mais recentes) para
saber o que está prestes a ir ao ar.

## 2. Backend — testes e build

```bash
cd backend
npx tsc -p tsconfig.json --noEmit
npm test
```
Os dois têm que passar limpo. Se algo quebrou, pare aqui — não faz sentido seguir a
checklist com o código quebrado.

## 3. Frontend — build

```bash
cd frontend
npx tsc -b
npm run build
```

## 4. Dependências — `npm audit`

Rode `npm audit` em `backend/` e `frontend/`. Compare com o que está documentado em
`docs/security-audit/infra-snapshot.md` (última rodada conhecida) — reporte qualquer
vulnerabilidade **nova** (alta/crítica principalmente) que tenha aparecido desde então.
Vulnerabilidades moderadas conhecidas e já avaliadas não bloqueiam o deploy sozinhas, mas
avise se a lista mudou.

## 5. Variáveis de ambiente do Vercel — o item que mais gera incidente silencioso

Isto já pegou um bug real em produção nesta base de código (uma env var salva com o nome
digitado errado, nunca detectada até uma auditoria manual — ver
`docs/security-audit/infra-snapshot.md`). Não pule este passo.

1. Rode `vercel env ls production` e `vercel env ls preview` para os dois projetos
   (`crmtopconta-backend` e `crmtopconta-frontend`; linkar com `vercel link --yes --team
   <team> --project <project-id>` em cada diretório se ainda não estiver linkado — os IDs
   estão em `docs/security-audit/infra-snapshot.md`).
2. Compare os **nomes exatos** contra `backend/.env.example` (a lista canônica de variáveis
   que o app espera) — procure especificamente por:
   - Variável obrigatória ausente (`DATABASE_URL`, `JWT_SECRET`, `CREDENTIALS_ENCRYPTION_KEY`
     — o app falha no boot sem elas, ver `backend/src/config/env.ts`).
   - Nome digitado errado/typo (compare caractere a caractere com o `.env.example`, não só
     "parece com" — foi exatamente assim que o bug anterior passou despercebido).
   - Presente em Production mas ausente em Preview (ou vice-versa) de forma inconsistente.
   - Uma variável nova que o código passou a exigir/usar (checar `git diff` desde o último
     deploy por novos `process.env.X`/`env.X` no backend) mas que ainda não foi provisionada.
3. Confira especificamente `ALLOWED_ORIGINS` (Production) contra o domínio real do frontend
   — se o frontend ganhou um domínio customizado desde o último deploy, essa lista precisa
   incluir o novo domínio, ou o CORS passa a bloquear a produção.
4. Frontend não deveria ter nenhuma variável `VITE_*` com segredo de backend — confirme que
   continua vazio ou só com valores que são seguros de expor no bundle público.

## 6. Supabase — schema e advisors

1. Se houve mudança em `backend/prisma/schema.prisma` desde o último deploy: a mudança
   **não** vai pro Supabase sozinha com o deploy da Vercel — precisa ser aplicada
   manualmente antes, via `prisma migrate diff --from-empty --to-schema-datamodel
   prisma/schema.prisma --script` rodado direto contra o Supabase (nunca `prisma migrate
   deploy` — não há caminho de rede daqui até o banco para isso, ver `CLAUDE.md`). Confirme
   que isso já foi feito, ou o deploy vai subir código esperando colunas/tabelas que não
   existem ainda.
2. Rode `get_advisors(type=security)` via MCP do Supabase — reporte qualquer lint novo desde
   a última rodada conhecida (`docs/security-audit/findings.md`), principalmente qualquer
   coisa além do já conhecido "RLS sem policy" (que é risco aceito/roadmap, documentado).

## 7. Vercel — deployment protection e cron

1. `get_project_deployment_protection` nos dois projetos — confirme que continua como o
   esperado (hoje: sem SSO/senha/IP, perímetro é 100% a autenticação da própria aplicação).
   Só é um problema se alguém ligou proteção sem querer (bloquearia o próprio frontend de
   funcionar) ou se alguém queria ligar e não ligou.
2. Se `backend/vercel.json` (seção `crons`) mudou desde o último deploy: lembre que o plano
   Hobby da Vercel limita cron a 1x/dia — jobs que rodavam mais frequentemente localmente via
   `node-cron` (dispatch de campanha, motor de automação, refresh de segmento dinâmico) ficam
   comprimidos em horários fixos diários em produção, compensados pelos botões manuais
   "Disparar lote"/"Atualizar agora"/"Sincronizar agora" na UI — confirme que isso ainda está
   coerente com o que o `vercel.json` de fato configura.

## 8. Resumo final

Apresente um resumo curto (✅/⚠️/❌ por item, 1-7 acima) e SÓ DEPOIS pergunte se o usuário
quer prosseguir com o deploy de fato. Se prosseguir, o caminho normal é `git push` pro
branch que a Vercel já observa (deploy automático via integração GitHub) — não rode `vercel
deploy --prod` diretamente a menos que o usuário peça explicitamente esse caminho
alternativo. Nunca dispare o deploy sem essa confirmação explícita, mesmo que todos os itens
acima estejam ✅.

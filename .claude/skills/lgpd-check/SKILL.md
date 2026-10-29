---
name: lgpd-check
description: Checagem LGPD leve e incremental do CRM TopConta, só sobre o diff atual, uma branch ou uma PR. Use antes de commit/PR que mexa em dado pessoal, quando o usuário disser "/lgpd-check", "isso fere a LGPD?", "checa LGPD do diff", ou ao fechar uma rodada de correções LGPD.
---

# /lgpd-check: LGPD no diff

Versão incremental da `/lgpd-audit`, com os mesmos checklists e o mesmo contrato de achado, mas olhando
**só o que mudou**. Não usa Workflow: de 1 a 3 subagents via ferramenta Agent.

## 1. Delimitar o diff

- Argumento vazio: mudanças locais contra a branch principal,
  `git diff $(git merge-base HEAD origin/claude/crm-google-sheets-d5hfks)` (inclui não commitado).
- Argumento `<branch>` ou `<base>..<head>`: esse intervalo.
- Argumento `#<n>` ou URL de PR: `gh pr diff <n>`.

Liste os arquivos alterados. Se nenhum estiver em `backend/`, `frontend/src/` ou `backend/prisma/`,
responda "sem impacto LGPD no diff" e pare.

## 2. Escolher dimensões

Mapeie arquivo → dimensão pelo "onde olhar" dos checklists em
`.claude/skills/lgpd-audit/references/`. Atalhos:

| Mudou… | Dimensões |
|--------|-----------|
| `schema.prisma`, `prisma/sql/*`, importação (`importService`, `cardAccountImport`, `purchaseImport`) | 01, 04 |
| envio e opt-out (`campaignQueue`, `automationEngine`, `channels/*`, `whatsapp*`, `manualCampaign`) | 02, 06 |
| rotas que leem ou exportam cliente (`routes/clients`, `campaigns` report, `dashboard`, `inbox`) | 03, 07 |
| `retention.ts`, `cron.ts`, `scheduler.ts`, `vercel.json` | 04 |
| `middleware/*`, `auth*`, `crypto`, `webhookAuth` | 05 |
| `fetch`/`axios` para host novo, dependência nova no `package.json`, script no `index.html` | 06 |
| qualquer `console.*`, `localStorage`, tratamento de erro | 07 |
| `Tenant`, `routes/tenant`, `audit`, roles | 08 |

Sempre inclua a 07 se o diff adiciona `console.*` ou novos campos em resposta de API.

## 3. Rodar

Agrupe as dimensões escolhidas em até 3 subagents (`general-purpose`), em paralelo numa única mensagem.
Prompt de cada um:

- leia `docs/lgpd/README.md`, `.claude/skills/lgpd-audit/references/finding-schema.md` e os checklists das
  suas dimensões;
- avalie **apenas** o diff (passe a lista de arquivos e o comando de diff) e o código que ele toca
  diretamente;
- um achado só conta se o diff **introduz ou piora** o problema; problema pré-existente vira uma nota
  "pré-existente, ver auditoria";
- mesmas regras do finding-schema (âncora válida, `arquivo:linha`, sem PII real) e somente leitura; sem
  MCP.

Antes de reportar, verifique você mesmo cada achado: abra o `arquivo:linha` e a âncora citada
(`grep 'id="..."'`). Descarte o que não se sustentar.

## 4. Saída (terminal, curta)

```
LGPD check: <intervalo> (<n> arquivos, dimensões 02, 07)
✗ [alta] 07-xx Telefone em claro no log do webhook. backend/src/routes/integrations.ts:391. LGPD art. 46
✓ 02 opt-out continua aplicado em campaignQueue.ts:185
ℹ pré-existente: 04-03 (ver docs/lgpd/auditoria/<última>/relatorio.md)
```

Achados graves (`critica`/`alta`) bloqueiam: recomende corrigir antes do commit/PR. Não grave arquivo,
a menos que o usuário peça.

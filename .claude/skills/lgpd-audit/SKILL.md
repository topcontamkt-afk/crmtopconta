---
name: lgpd-audit
description: Varredura completa de conformidade LGPD do CRM TopConta. Usa vários subagents (um por dimensão da lei), verifica cada achado de forma adversarial e grava o relatório em docs/lgpd/auditoria/<data>/. Use quando o usuário disser "/lgpd-audit", "auditoria LGPD", "varrer o código atrás de infrações à LGPD" ou pedir uma nova rodada pós-correção.
---

# /lgpd-audit: varredura LGPD multi-agente

Invocar esta skill é o opt-in explícito para rodar o **Workflow** multi-agente descrito aqui
(cerca de 17 agentes: 8 de varredura, até 8 de verificação e 1 de consolidação).

## Antes de rodar

1. Leia `docs/lgpd/README.md` (papéis, convenção de citação) e `references/finding-schema.md`.
2. Confirme que o corpus existe: `ls docs/lgpd/fontes/*.md`. Sem corpus não há como citar, então pare e
   avise.
3. Anote o commit: `git rev-parse --short HEAD`. Se houver mudanças não commitadas em `backend/` ou
   `frontend/`, avise que a varredura vai considerá-las.
4. Defina `data` = hoje (AAAA-MM-DD). Se `docs/lgpd/auditoria/<data>/` já existir, use o sufixo `-2`,
   `-3`... em `saida`, nunca sobrescreva uma rodada anterior.

## Rodar

Chame a ferramenta Workflow com o script versionado:

```
Workflow({
  scriptPath: ".claude/skills/lgpd-audit/workflow.js",
  args: { data: "<AAAA-MM-DD>", saida: "docs/lgpd/auditoria/<AAAA-MM-DD>" }
})
```

Rodada parcial (ex.: reverificar só o que foi corrigido): `args.dimensoes: ["04", "07"]` e uma `saida`
própria, ex. `docs/lgpd/auditoria/<data>-pos`.

O script faz:

| Fase | O quê |
|------|-------|
| Varredura | Um agente por dimensão (`references/01..08-*.md`) percorre o checklist contra o código em HEAD e devolve `achados` e `cobertura` (todo item do checklist recebe status). |
| Verificação | Assim que a varredura de uma dimensão termina, sem esperar as outras, um verificador tenta **refutar** cada achado: confere trecho e linha, procura mitigação ignorada, abre o artigo citado e reavalia a severidade. Saem REFUTED e citações com âncora inexistente. |
| Consolidação | Deduplica entre dimensões e escreve `relatorio.md`, `achados.json`, `decisoes-pendentes.md` e `fora-do-codigo.md` no diretório de saída. |

## Regras de escopo (já embutidas nos prompts; reforce se rodar algo à mão)

- Varredura e verificação são **somente leitura**. Só a consolidação escreve, e só no diretório de saída.
- MCP: apenas metadados e logs, em leitura. Vercel: `get_project`, `list_deployments`,
  `get_runtime_logs`, `get_runtime_errors`. Supabase: `get_advisors`, `list_tables`, `list_extensions`,
  `list_migrations`. **Proibido** `execute_sql`, `apply_migration`, qualquer escrita, connection string
  ou ler `.env`.
- Nenhum dado pessoal real no relatório: mascarar sempre.
- O corpus em `docs/lgpd/fontes/` é a única fonte legal. Nada de "a LGPD diz" sem âncora.

## Depois de rodar

1. Leia o `relatorio.md` gerado e confira por amostragem 2 ou 3 achados `critica`/`alta` (abra o
   arquivo:linha). Se algum estiver errado, corrija o relatório e registre o motivo.
2. Valide os links do relatório:
   ```bash
   python3 -I - docs/lgpd/auditoria/<data> <<'EOF'
   import re,sys,os,glob
   for f in glob.glob(sys.argv[1]+'/*.md'):
       for m in re.finditer(r'\]\(([^)#]+\.md)#([^)]+)\)', open(f).read()):
           p=os.path.normpath(os.path.join(os.path.dirname(f),m.group(1)))
           if not os.path.exists(p) or f'id="{m.group(2)}"' not in open(p).read(): print('QUEBRADO',f,m.group(0))
   EOF
   ```
3. Se o workflow registrou dimensões com falha, rode de novo só elas (`args.dimensoes`) na mesma `saida`
   com sufixo e junte os resultados.
4. **Checkpoint de triagem**: apresente ao usuário a contagem por severidade, os 5 achados mais graves
   e a lista de `decisoes-pendentes.md` com a recomendação de cada um. **Não corrija nada antes das
   decisões do usuário.**

## Manutenção

- Checklists em `references/`, um por dimensão. Ao adicionar item, inclua dispositivo com âncora válida e
  o "onde olhar". Ao criar dimensão nova, registre-a em `DIMENSOES` no `workflow.js`.
- Ao atualizar o corpus (`docs/lgpd/fontes/SOURCES.md`), revalide as âncoras dos checklists com o
  script do passo 2 apontado para `.claude/skills/lgpd-audit/references`.

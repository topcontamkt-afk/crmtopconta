---
tags: [segmentação, automação, cron]
created: 2026-09-10
updated: 2026-09-10
sources: [repository-analysis.md]
---

# Segmentação e automações

> Filtros salvos e regras ativas transformam sinais de uso e relacionamento em ações comerciais.

## Segmentos

`segments.ts` aceita filtros simples e grupos recursivos com operadores `AND` e `OR`. Segmentos dinâmicos podem possuir `refreshCron`, sendo recalculados pelo scheduler. O endpoint de preview permite validar o público antes de salvar ou usar em campanha.

## Gatilhos de automação

- Cliente novo ou novo sem uso.
- Reativação após período de inatividade.
- Renovação/aumento de limite detectado por `Movement`.
- Faixa de uso que exige estímulo.
- Opt-out ou telefone inválido, que deve bloquear comunicação.

## Ações

- Criar e disparar campanha.
- Criar notificação interna.
- Bloquear diretamente.

O motor reaproveita a janela de dedupe existente para evitar repetição automática.

## Relações

- [[wiki/topics/pipeline-de-importacao.md]]
- [[wiki/topics/campanhas-e-mensageria.md]]
- [[wiki/topics/operacao-e-deploy.md]]

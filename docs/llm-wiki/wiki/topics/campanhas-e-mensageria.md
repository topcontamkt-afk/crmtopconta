---
tags: [campanhas, WhatsApp, SMS, fila, A/B testing]
created: 2026-09-10
updated: 2026-09-10
sources: [repository-analysis.md]
---

# Campanhas e mensageria

> A audiência é filtrada e enfileirada no Postgres antes de ser entregue por adaptadores de canal.

## Fluxo de envio

```mermaid
flowchart LR
  F[segmento ou filtros] --> A[preview de audiência]
  A --> E[opt-out + dedupe]
  E --> Q[MessageEvent FILA]
  Q --> B[dispatch em lote]
  B --> T[throttle por tenant/campanha]
  T --> AD[ChannelAdapter]
  AD --> W[WhatsApp Cloud API]
  AD --> S[SMS: Twilio/Zenvia/mock]
  W --> H[webhook]
  S --> H
  H --> R[entregue, lido, respondido ou falha]
  R --> P[relatório e conversão]
```

## Capacidades

- Público por segmento salvo ou filtros ad hoc.
- Templates aprovados e preview com placeholders.
- Agendamento e dispatch manual.
- Janela de dedupe e limite global de mensagens por tenant.
- Failover entre provedores SMS por prioridade.
- `test-send` para amostra sem tocar no público real.
- Variante A/B e teste z de duas proporções, com alerta para amostras pequenas.
- Relatório de status, custo, conversão, lucro atribuído e exportação CSV com a lista nominal de quem usou.
- Conversão medida pelo uso real (compras do extrato `Purchase`: antecipação e compra contam; assinatura e débito de fatura não), em curva acumulada D0 a D30 por dia de calendário de Brasília, calculada na consulta. O uso vai para a campanha mais recente do cliente.
- Separação de quem tinha saldo na data do envio (histórico `AccountSnapshot`) de quem não tinha ou de saldo desconhecido.
- Grupo de controle opcional (`MessageStatus.CONTROLE`): parte do público fica sem mensagem; o relatório mostra o lift real e o lucro incremental.

## Segurança operacional

Webhook deve ser idempotente e autenticado. Credenciais são armazenadas cifradas. Opt-out precisa ser aplicado tanto no preview quanto no enfileiramento, evitando que uma alteração entre as duas etapas gere envio indevido.

## Relações

- [[wiki/topics/modelo-de-dominio.md]]
- [[wiki/topics/segmentacao-e-automacoes.md]]
- [[wiki/topics/seguranca-e-lgpd.md]]

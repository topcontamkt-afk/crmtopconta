---
tags: [domínio, Prisma, PostgreSQL, dados]
created: 2026-09-10
updated: 2026-09-10
sources: [repository-analysis.md]
---

# Modelo de domínio

> O tenant é a fronteira de isolamento e as entidades suportam clientes, campanhas, histórico e operação.

## Entidades centrais

| Entidade | Responsabilidade |
|---|---|
| `Tenant` | Configurações, retenção e limite global de mensagens. |
| `User` | Identidade, papel, lockout e 2FA. |
| `Client` | Dados cadastrais, uso, status, opt-out e anonimização. |
| `ImportJob` | Execução, contagens, status e erros de importação. |
| `Movement` | Histórico de alterações e base para conversões. |
| `SegmentDefinition` | Filtros salvos e refresh dinâmico. |
| `Campaign` | Mensagem, canal, público, agenda, throttle e A/B. |
| `MessageEvent` | Fila e estado de cada envio. |
| `AutomationRule` | Gatilho, condição e ação. |
| `AuditLog` | Registro encadeado de ações sensíveis. |
| `SheetConnection` | Origem e sincronização de planilha. |
| `ChannelConfig` | Provedor, prioridade e credencial cifrada. |
| `MessageTemplate` | Corpo e aprovação de templates. |
| `Notification` | Avisos internos para usuários do tenant. |

## Invariantes

- Consultas de domínio devem incluir `tenantId`.
- Opt-out não deve ser revertido silenciosamente por reimportação.
- CPF/CNPJ não devem ser persistidos em texto plano.
- `MessageEvent` deve respeitar dedupe e throttle antes do envio.
- `Movement` preserva histórico em vez de substituir toda a evidência da mudança.

## Relações

- [[wiki/topics/pipeline-de-importacao.md]]
- [[wiki/topics/segmentacao-e-automacoes.md]]
- [[wiki/topics/campanhas-e-mensageria.md]]

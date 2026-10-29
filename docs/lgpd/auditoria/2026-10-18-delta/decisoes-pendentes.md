# Decisões pendentes da controladora: auditoria LGPD incremental de 2026-10-18 (delta)

Commit: `0e47151` (código de `backend/` e `frontend/` idêntico a `ae033a0`; intervalo auditado `ce578a6..ae033a0`).
Achados completos em [relatorio.md](relatorio.md) e [achados.json](achados.json).

## Nenhum achado desta rodada é do tipo `decisao_negocio`

Os 7 achados do delta são 5 de `codigo` (a correção não depende de escolha da controladora) e 2 de `fora_do_codigo`
(04-08 e 06-04, listados em [fora-do-codigo.md](fora-do-codigo.md)). Por isso não há, aqui, pergunta nova com opções e
impacto no código.

As seis decisões da rodada anterior continuam valendo, com a implementação definida na
[triagem](../2026-10-18/triagem.md). Ver [decisoes-pendentes.md da rodada anterior](../2026-10-18/decisoes-pendentes.md).

## Escolhas da controladora que aparecem dentro dos achados do delta

Nenhuma delas muda a correção de código, que já tem padrão conservador definido. Ficam registradas para a controladora
confirmar junto das decisões anteriores:

| Escolha | Achado | Onde a controladora responde | Padrão que o código implementa enquanto isso |
|---------|--------|------------------------------|----------------------------------------------|
| As finalidades novas (campanha pela Z-API, resposta automática da Inbox, ligação por IA de voz) entram na mesma base legal dos disparos? | 02-07, 02-08, 06-04 | Decisão 1 da [triagem](../2026-10-18/triagem.md) (legítimo interesse por tenant): a LIA e `Tenant.baseLegalMarketing` precisam citar essas finalidades. Base: [LGPD art. 7º](../../fontes/lei-13709.md#art-7), [art. 10](../../fontes/lei-13709.md#art-10). | Envio bloqueado se o tenant não declarou base, como já decidido na triagem. |
| Usar ou não um provedor não oficial (Z-API), que viola os termos do WhatsApp e pode levar ao bloqueio do número, que é também o canal de opt-out do titular | 04-08, 06-04 | [fora-do-codigo.md](fora-do-codigo.md), seção 1 | Nenhuma mudança: a Z-API continua opcional por tenant, escolhida pelo ADMIN. |
| Política do celular pareado à Z-API (aparelho dedicado, temporizador de mensagens, despareamento) | 04-08 | [fora-do-codigo.md](fora-do-codigo.md), seção 1 | Confirmação da política exigida do ADMIN ao ativar a Z-API, com registro no AuditLog. |
| Texto da resposta automática e canal do titular que ela indica | 02-08 | [fora-do-codigo.md](fora-do-codigo.md), seção 3 | Resposta automática desligada em contas novas e sem texto ou canal configurado. |
| Janela de resposta da Inbox em canal não oficial | 02-06 | Não exige decisão: 24 h desde a última mensagem do titular, como na Meta. Se algum tenant precisar de outro valor, vira configuração por tenant. | 24 h; o bloqueio por opt-out não é configurável ([art. 18, §2º](../../fontes/lei-13709.md#art-18)). |

> Não é parecer jurídico. A escolha final deve passar por revisão jurídica.

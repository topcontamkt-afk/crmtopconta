# LGPD: adequação do CRM TopConta

Este diretório é a fonte de verdade para conformidade com a LGPD (Lei 13.709/2018) no CRM TopConta.
Ele guarda os textos legais, os relatórios de varredura do código e os artefatos produzidos para
adequação.

> **Não é parecer jurídico.** É uma checagem técnica de engenharia ancorada no texto oficial. Decisões
> de base legal, contratos e nomeação de encarregado são da controladora e devem passar por revisão
> jurídica.

## Estrutura

```
docs/lgpd/
  README.md            este arquivo
  fontes/              textos oficiais (original intacto + Markdown citável)
    SOURCES.md         URL, data de captura, sha256 e status de cada ato
    original/          HTML/PDF como baixados; nunca editar
    ferramentas/       conversor original → Markdown
    lei-13709.md, anpd-res-*.md, anpd-guia-legitimo-interesse.md
  auditoria/<data>/    saída de cada rodada da skill /lgpd-audit
  artefatos/           rascunhos: registro de operações, aviso de privacidade, LIA,
                       incidentes, suboperadores (requerem revisão jurídica)
  pendencias-fora-do-codigo.md   andamento do que o código não resolve
```

## Papéis no tratamento

| Agente | Papel LGPD | Observação |
|--------|------------|------------|
| TopConta | **Controladora** (art. 5º, VI) | Decide finalidade e meios. Os clientes no CRM são clientes da TopConta. Base legal dos disparos **ainda não formalizada**. |
| Luan (contratado da TopConta, opera os disparos) | **Operador** (art. 5º, VII; art. 39) | Trata em nome da controladora e segue as instruções dela. |
| Quem desenvolve e hospeda o CRM | **Operador** | Idem. |
| Meta (WhatsApp Cloud API), Twilio, Zenvia, Google (Sheets), Vercel, Supabase | **Suboperadores** | Fora do Brasil, em princípio, o que exige análise de transferência internacional (arts. 33–36; Res. 19/2024). |

O produto deve poder servir **vários controladores** no futuro. Cada `Tenant` é um controlador
distinto, então tudo que for configuração LGPD (base legal, encarregado, aviso de privacidade,
retenção, texto de opt-out) é por tenant, nunca fixo para a TopConta.

## Como citar

Todo achado ou decisão cita o dispositivo exato com link para a âncora:

- `[LGPD art. 7º, IX](fontes/lei-13709.md#art-7)`
- `[Res. 15/2024, Anexo, art. 6º](fontes/anpd-res-15-2024-incidentes.md#anexo-art-6)`
- `[Guia LI, p. 30](fontes/anpd-guia-legitimo-interesse.md#p-30)`

Convenções de âncora em [fontes/SOURCES.md](fontes/SOURCES.md#âncoras).

## Mapa rápido: obrigação → fonte

| Tema | Onde |
|------|------|
| Princípios (finalidade, necessidade, transparência, segurança, prevenção, responsabilização) | [LGPD art. 6º](fontes/lei-13709.md#art-6) |
| Bases legais | [art. 7º](fontes/lei-13709.md#art-7), consentimento [art. 8º](fontes/lei-13709.md#art-8), legítimo interesse [art. 10](fontes/lei-13709.md#art-10) + [Guia LI](fontes/anpd-guia-legitimo-interesse.md) |
| Dados sensíveis | [art. 11](fontes/lei-13709.md#art-11) |
| Transparência ao titular | [art. 9º](fontes/lei-13709.md#art-9) |
| Término do tratamento e eliminação | [arts. 15](fontes/lei-13709.md#art-15) e [16](fontes/lei-13709.md#art-16) |
| Direitos do titular | [arts. 17–22](fontes/lei-13709.md#art-18), prazo de resposta no [art. 19](fontes/lei-13709.md#art-19) |
| Transferência internacional | [arts. 33–36](fontes/lei-13709.md#art-33), [Res. 19/2024](fontes/anpd-res-19-2024-transf-intl.md), [Res. 32/2026](fontes/anpd-res-32-2026-adequacao-ue.md) |
| Registro de operações, RIPD | [arts. 37–38](fontes/lei-13709.md#art-37) |
| Operador | [art. 39](fontes/lei-13709.md#art-39) |
| Encarregado | [art. 41](fontes/lei-13709.md#art-41), [Res. 18/2024](fontes/anpd-res-18-2024-encarregado.md) |
| Responsabilidade | [arts. 42–45](fontes/lei-13709.md#art-42) |
| Segurança e incidentes | [arts. 46–49](fontes/lei-13709.md#art-46), [Res. 15/2024](fontes/anpd-res-15-2024-incidentes.md) |
| Boas práticas e governança | [art. 50](fontes/lei-13709.md#art-50) |
| Sanções | [art. 52](fontes/lei-13709.md#art-52), [Res. 4/2023](fontes/anpd-res-04-2023-dosimetria.md) |
| Regime simplificado | [Res. 2/2022](fontes/anpd-res-02-2022-pequeno-porte.md) |

## Skills

- `/lgpd-audit`: varredura completa do repositório com vários subagents (uma dimensão por agente) e
  verificação adversarial de cada achado. A saída vai para `auditoria/<data>/`.
- `/lgpd-check`: versão leve, só sobre o diff atual ou uma PR, para não regredir.

Ambas ficam em `.claude/skills/` e usam este corpus como única fonte legal.

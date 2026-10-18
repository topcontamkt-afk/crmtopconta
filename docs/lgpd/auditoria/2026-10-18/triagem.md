# Triagem da varredura 2026-10-18

Decisões tomadas em 2026-10-18 pelo responsável técnico (Filipe), a partir de
[decisoes-pendentes.md](decisoes-pendentes.md). Elas definem o que o **código** implementa agora. Onde a
decisão é da controladora, o código implementa a recomendação como **configuração por tenant** com
padrão conservador. O valor da TopConta fica marcado como "pendente de confirmação da controladora" até ela
formalizar (ver [fora-do-codigo.md](fora-do-codigo.md)).

| # | Tema | Decisão para o código | Pendente da TopConta |
|---|------|-----------------------|----------------------|
| 0 | Base das correções | Branch `claude/lgpd-adequacao` rebaseada sobre `origin/claude/dreamy-brown-hvs4h6` (linha que está em produção: `ce578a6` + 16 commits, inclusive Z-API). Antes de corrigir, rodar `/lgpd-audit` parcial sobre esse delta. | Confirmar qual branch é a linha oficial de produção |
| 1 | Base legal dos disparos (02-01) | **Legítimo interesse configurável por tenant**: `Tenant.baseLegalMarketing`, versão e data de aprovação da LIA. Envio bloqueado se o tenant não declarou base. Rodapé com identificação do controlador e instrução de opt-out obrigatório. Lista manual de **não clientes** exige consentimento com prova. Seed TopConta: legítimo interesse, LIA pendente. | LIA (template em `docs/lgpd/artefatos/`) |
| 2 | Aniversário e renda (01-03) | Aniversário mantido como finalidade declarada. Renda **só como estatística**: sai dos filtros de público e dos segmentos prontos. | Declarar finalidades no registro de operações |
| 3 | Campos sem finalidade (01-01) | Deixam de ser importados: e-mail, lotação, bônus, saldo líquido para saque, vínculo, cidade da conveniada, observação e motivo de encerramento, razão social, status de validação. SQL idempotente zera os valores existentes; a remoção das colunas fica para migração posterior. | Indicar algum campo com uso concreto, se houver |
| 4 | Encerramento (04-06) | Conta encerrada sai de todo uso comercial. Anonimização após `Tenant.retentionDaysAfterClosure` (padrão = prazo geral até a TopConta definir). `encerradoEm` preserva a primeira data. | Prazo pós-encerramento e obrigação legal |
| 5 | Prazo geral (04-07) | Mantém 1095 dias. `Tenant.retentionBasis` obrigatório ao mudar, limites de 30 a 1825 dias, prévia do impacto. | Fundamento do prazo |
| 6 | Correção de dados (03-03) | Correção manual trava o campo contra reimportação (`Client.camposCorrigidos`) e avisa o responsável pela planilha. Configurável por tenant. PATCH passa a aceitar telefone e e-mail normalizados. | — |

Todos os achados de tipo `codigo` serão corrigidos, com teste que prove cada correção. Os de tipo
`fora_do_codigo` ficam em [fora-do-codigo.md](fora-do-codigo.md), e os contratos são resolvidos à parte.

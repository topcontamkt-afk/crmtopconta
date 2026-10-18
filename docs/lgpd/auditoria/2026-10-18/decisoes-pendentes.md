# Decisões pendentes da controladora: auditoria LGPD de 2026-10-18

Commit auditado: `c3f09cd`. Achados completos em [relatorio.md](relatorio.md) e [achados.json](achados.json).

Estes 6 achados são do tipo `decisao_negocio`: a correção no código depende de uma escolha que cabe à TopConta como
controladora ([LGPD art. 5º, VI](../../fontes/lei-13709.md#art-5)). Para cada um há a pergunta, as opções, o que cada
opção muda no código e uma recomendação técnica. A recomendação não é parecer jurídico: a escolha final deve passar por
revisão jurídica.

A ordem segue a dependência. A decisão 1 (base legal) define o que as demais precisam declarar.

| # | Achado | Pergunta curta | Severidade |
|---|--------|----------------|------------|
| 1 | 02-01 | Qual a base legal dos disparos de marketing? | média (original: alta) |
| 2 | 01-03 | Aniversário e faixa de renda são finalidades declaradas? | média |
| 3 | 01-01 | Quais campos da planilha "Cartões e contas" têm finalidade? | média |
| 4 | 04-06 | O encerramento da conta encerra o tratamento? | média |
| 5 | 04-07 | Qual o prazo geral de retenção e o fundamento dele? | baixa |
| 6 | 03-03 | Quando o titular pede correção, vale a planilha ou o CRM? | média |

---

## 1. Base legal dos disparos de marketing (02-01)

**Pergunta à controladora:** em qual hipótese do art. 7º a TopConta se apoia para enviar mensagens de marketing por
WhatsApp e SMS (campanhas, listas manuais e automações) aos clientes do cartão, e onde está a prova?

Hoje o código presume a resposta: `backend/src/services/cardAccountImport.ts:253` diz em comentário que a base é "aceite no
contrato" e marca como autorizado todo cadastro não reprovado. Nenhuma tabela registra base, finalidade, versão de termo ou
LIA ([LGPD art. 7º](../../fontes/lei-13709.md#art-7), [art. 8º](../../fontes/lei-13709.md#art-8),
[art. 10](../../fontes/lei-13709.md#art-10)).

| Opção | O que significa | Impacto no código |
|-------|-----------------|-------------------|
| A. Consentimento ([art. 7º, I](../../fontes/lei-13709.md#art-7); [art. 8º](../../fontes/lei-13709.md#art-8)) | A TopConta prova, para cada titular, quando, por qual canal e com qual texto ele aceitou receber marketing. O ônus da prova é dela (art. 8º, §2º). | Nova tabela `ConsentRecord` (tenantId, cliente ou telefone, finalidade, canal, versão do texto, origem, data, revogação). `autorizacaoComunicacao` passa a ser derivada de um consentimento ativo. `cardAccountImport.ts` deixa de usar `!isReprovado` e só autoriza com coluna de aceite datada vinda da origem. A base atual, sem prova, fica bloqueada até uma campanha de recoleta. |
| B. Legítimo interesse ([art. 7º, IX](../../fontes/lei-13709.md#art-7); [art. 10](../../fontes/lei-13709.md#art-10)) | A TopConta documenta a finalidade concreta, faz o teste de balanceamento (LIA) e garante transparência e descadastro fácil ([Guia LI, p. 25](../../fontes/anpd-guia-legitimo-interesse.md#p-25), [p. 26](../../fontes/anpd-guia-legitimo-interesse.md#p-26), [p. 52](../../fontes/anpd-guia-legitimo-interesse.md#p-52)). | Campos `Tenant.baseLegalMarketing`, `liaVersao` e `liaAprovadaEm`; `Campaign` e `AutomationRule` guardam a base vigente no disparo; envio bloqueado se o tenant não declarou base. Exige as salvaguardas de 02-05 (identificação do controlador e instrução de opt-out na mensagem), 02-03 e 02-04 (opt-out por telefone e por qualquer canal) e a revisão dos filtros por renda, lotação e vínculo (art. 10, §1º). |
| C. Não decidir agora | Os envios continuam com base presumida. | Nenhuma mudança. O risco do achado permanece, e um segundo tenant herda a mesma suposição. |

**Recomendação:** opção B, legítimo interesse, para clientes ativos da própria TopConta com relação contratual prévia,
em mensagens sobre o próprio cartão (limite renovado, ciclo aberto, estímulo de uso). É o cenário do exemplo 5 do Guia LI
([p. 17](../../fontes/anpd-guia-legitimo-interesse.md#p-17)–[18](../../fontes/anpd-guia-legitimo-interesse.md#p-18):
promoção a quem já tem relação, com descadastro na própria mensagem). Contatos de lista manual que não são clientes não têm
relação prévia: para eles, consentimento com prova ou não enviar. As automações entram na mesma LIA desde que tenham a mesma
finalidade; finalidade diferente precisa de teste próprio. A LIA é documento da controladora (ver
[fora-do-codigo.md](fora-do-codigo.md)).

**Destrava:** 02-02 (origem da autorização na importação), 02-05 (rodapé obrigatório), 01-03 (finalidades secundárias).

---

## 2. Finalidades de aniversário e de faixa de renda (01-03)

**Pergunta à controladora:** usar a data de nascimento vinda da folha para campanhas de "Aniversariantes do mês" e usar a
renda (real ou estimada pelo limite) para escolher público de campanha são finalidades que a TopConta declarou ao titular e
considera compatíveis com a coleta original ([LGPD art. 6º, I e II](../../fontes/lei-13709.md#art-6))?

Hoje `backend/src/services/opportunities.ts:135` gera público de até 5.000 aniversariantes com mensagem pronta,
`backend/src/routes/dashboard.ts:329` agrega remuneração e `backend/src/services/segments.ts:93` filtra por perfil de renda
PF1–PF4.

| Opção | O que significa | Impacto no código |
|-------|-----------------|-------------------|
| A. Declarar as finalidades | "Relacionamento por aniversário" e "segmentação por faixa de renda" entram no registro de operações, no aviso de privacidade e, se a base for legítimo interesse, na LIA. | Nenhuma mudança obrigatória. Opcional: flags por tenant que só mostram a oportunidade e o filtro quando a finalidade foi registrada. |
| B. Renda só como estatística | O perfil de renda continua no dashboard agregado, mas deixa de escolher público. | Retirar `perfilRenda` dos filtros de público em `services/segments.ts` e dos segmentos prontos; manter `PerfisRenda.tsx` só como relatório. |
| C. Parar de coletar | Data de nascimento e remuneração deixam de ser importadas. | Remover os campos do mapeamento e de `prepareRow` (ver decisão 3), apagar a oportunidade "aniversariantes" em `services/opportunities.ts` e a faixa etária do dashboard. |

**Recomendação:** A para o aniversário, uso de baixo impacto, desde que fique declarado. B para a renda até que a
finalidade de segmentar por renda esteja documentada. Observação do verificador: o filtro PF1–PF4 usa só o limite do cartão,
dado do próprio produto; o ponto mais sensível é a data de nascimento vinda do RH do convênio.

---

## 3. Campos importados sem finalidade (01-01)

**Pergunta à controladora:** quais destes campos da planilha "Cartões e contas" a TopConta precisa guardar, e para quê?
E-mail, lotação, bônus, saldo líquido para saque, vínculo empregatício, cidade da empresa conveniada, observação e motivo de
encerramento, razão social e status de validação do cadastro.

Hoje `backend/src/services/cardAccountImport.ts:224-252` grava todos eles e nenhuma tela, segmento, template ou automação os
lê. Só saem pela resposta integral de `GET /api/clients` (01-04). Guardar dado sem uso contraria a necessidade
([LGPD art. 6º, III](../../fontes/lei-13709.md#art-6)).

| Opção | O que significa | Impacto no código |
|-------|-----------------|-------------------|
| A. Parar de coletar o que não tem leitor | A importação ignora essas colunas. | Remover as chaves de `CARD_ACCOUNT_FIELDS` (`frontend/src/utils/importFields.ts`) e de `prepareRow`. `status_cadastro` continua sendo lido para inferir `statusConta`, sem ser gravado. Script em `backend/prisma/sql/` zera as colunas nos clientes existentes e, depois, uma migração as remove do model `Client`. |
| B. Manter com finalidade | Para cada campo mantido, a controladora registra a finalidade e o produto passa a usá-lo. | Implementar o leitor que justifica a coleta (ex.: filtro por `vinculoEmpregaticio` em `services/segments.ts`), corrigir o comentário do schema e incluir o campo na anonimização de 04-01. |
| C. Escolha por tenant | Cada controladora define o que coleta. | Lista `Tenant.camposImportacao`; `autoMapColumns` e `prepareRow` ignoram colunas fora dela. |

**Recomendação:** A para todos os campos, salvo os que a controladora apontar com uso concreto (B). `motivoEncerramento`
só se justifica se `GET /api/dashboard/encerramentos` ganhar uma tela; caso contrário, sai junto. C é a evolução natural
quando houver segundo tenant.

---

## 4. Encerramento da conta como fim do tratamento (04-06)

**Pergunta à controladora:** quando o titular encerra a conta do cartão, a finalidade do CRM (estimular uso do cartão)
termina ([LGPD art. 15, I](../../fontes/lei-13709.md#art-15))? Existe obrigação legal ou de cobrança que exija guardar os
dados por algum prazo ([art. 16, I](../../fontes/lei-13709.md#art-16))?

Hoje a retenção trata o cliente encerrado como inativo comum (1095 dias desde a última utilização) e
`backend/src/services/cardAccountImport.ts:241` regrava `encerradoEm` com a data de cada importação, de modo que a data real
do encerramento se perde.

| Opção | O que significa | Impacto no código |
|-------|-----------------|-------------------|
| A. Prazo curto após o encerramento | Anonimizar N dias depois do encerramento. | Campo `Tenant.retentionDaysAfterClosure` e novo ramo em `services/retention.ts` (`encerradoEm <= corte`). |
| B. Prazo geral, sem uso comercial | Mantém 1095 dias, mas o cliente encerrado sai de toda campanha, automação e segmento. | Excluir `encerradoEm` não nulo em `buildSegmentWhere`, `campaignQueue`, `manualCampaign` e `automationEngine`. |
| C. Eliminar no encerramento | Anonimizar já no encerramento, salvo obrigação legal. | Anonimização disparada pela importação quando a linha chega encerrada. |

Em qualquer opção, `cardAccountImport.ts` passa a preencher `encerradoEm` só quando ele ainda é nulo.

**Recomendação:** A somada ao bloqueio comercial de B, com o prazo de A definido pela obrigação legal ou de cobrança que
a controladora identificar.

---

## 5. Prazo geral de retenção e fundamento (04-07)

**Pergunta à controladora:** qual o prazo de guarda dos dados de clientes inativos e em que ele se baseia (obrigação legal,
prazo prescricional, finalidade)?

Hoje o padrão é 1095 dias sem justificativa registrada (`backend/prisma/schema.prisma:99`), e
`backend/src/routes/tenant.ts:23` aceita qualquer inteiro positivo: 1 dia anonimiza a base inteira na madrugada seguinte, 36500
dias é retenção indefinida. A mudança já é restrita a ADMIN e auditada. Registrar o fundamento é boa prática de
responsabilização e de registro das operações ([LGPD art. 6º, X](../../fontes/lei-13709.md#art-6),
[art. 37](../../fontes/lei-13709.md#art-37)).

| Opção | O que significa | Impacto no código |
|-------|-----------------|-------------------|
| A. Manter 1095 dias com fundamento | A controladora confirma 3 anos e registra o motivo. | Campo `Tenant.retentionBasis` (texto obrigatório quando o prazo mudar). |
| B. Outro prazo | A controladora define outro valor com base legal identificada. | Mesmo campo, mais o novo valor no tenant. |
| Em ambas | Proteção contra erro de digitação. | Limites em `routes/tenant.ts` (ex.: `.min(30).max(1825)`) e prévia de quantos clientes seriam anonimizados antes de salvar. |

**Recomendação:** definir o prazo a partir da obrigação legal ou do prazo prescricional aplicável ao produto, registrá-lo
em `retentionBasis` e no registro de operações, e aplicar os limites no código independentemente do valor escolhido.

---

## 6. Correção de dados: vale a planilha ou o CRM? (03-03)

**Pergunta à controladora:** quando um titular pede correção de nome, cidade, telefone ou e-mail
([LGPD art. 18, III](../../fontes/lei-13709.md#art-18)), onde a correção é feita?

Hoje a correção feita no CRM é sobrescrita na próxima importação ("última atualização ganha" em
`backend/src/services/importService.ts:197-201` e `backend/src/services/cardAccountImport.ts:219`), e o PATCH de cliente nem
aceita telefone e e-mail (`backend/src/routes/clients.ts:104`).

| Opção | O que significa | Impacto no código |
|-------|-----------------|-------------------|
| A. A fonte vence | A correção é feita só na planilha ou no sistema do cartão; o CRM registra a pendência e avisa. | Aviso na ficha do cliente e registro do pedido (03-05). Sem trava por campo. |
| B. A correção manual vence | O CRM guarda uma trava por campo corrigido que a importação respeita, como já faz com `optOutAt`. | Campo `Client.camposCorrigidos` (lista + data), respeitado por `importService.ts` e `cardAccountImport.ts`; a tela de impacto da importação mostra o conflito e notifica o responsável pela planilha. |

Em ambas: incluir `telefone` e `email` no `updateSchema` de `routes/clients.ts`, normalizando com `normalizePhone`.

**Recomendação:** B com notificação ao responsável pela planilha, porque também cumpre o dever de repassar a correção a
quem tem cópia do dado (art. 18, §6º). Pode virar configuração por tenant ("fonte vence" ou "correção manual vence" por campo).

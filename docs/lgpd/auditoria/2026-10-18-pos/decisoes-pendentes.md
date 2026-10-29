# Decisões pendentes da controladora: auditoria LGPD pós-correção de 2026-10-18

Commit: `4e20d5a` (branch `claude/lgpd-adequacao`). Achados completos em [relatorio.md](relatorio.md) e
[achados.json](achados.json).

Este arquivo traz só os achados novos do tipo `decisao_negocio`. Nesta rodada há um: **01-05**. As decisões das rodadas
anteriores que continuam abertas estão em [`correcoes/pendencias-integracao.md`](../../correcoes/pendencias-integracao.md)
(seção "Decidir depois") e em [`pendencias-fora-do-codigo.md`](../../pendencias-fora-do-codigo.md) (itens 10, 17 e 18) e não
são repetidas aqui.

> Não é parecer jurídico. A escolha é da controladora (TopConta) e deve passar por revisão jurídica.

## 01-05: manter ou cortar `sexo` e a faixa etária no perfil demográfico

- **Severidade:** baixa · **Papel:** controladora
- **Dispositivos:** [LGPD art. 6º](../../fontes/lei-13709.md#art-6) (I finalidade, III necessidade, VI transparência) e
  [LGPD art. 9º](../../fontes/lei-13709.md#art-9) (I finalidade específica informada ao titular)

**Situação hoje.** A importação de "Cartões e contas" grava o `sexo` de cada titular
(`backend/src/services/cardAccountImport.ts:237`, mapeado em `frontend/src/utils/importFields.ts:60`). O único uso é o card de
perfil do Dashboard, que mostra a base agrupada por sexo e por faixa etária calculada da data de nascimento
(`backend/src/routes/dashboard.ts:326-342`, `frontend/src/pages/Dashboard.tsx:475-495`). Nenhum segmento, campanha, automação
ou template usa esses dados. O rascunho do aviso de privacidade prevê a data de nascimento só para a mensagem de aniversário
e não cita sexo (`docs/lgpd/artefatos/aviso-de-privacidade.md:24`); o registro de operações lista sexo sem dizer para que
serve (`docs/lgpd/artefatos/registro-de-operacoes.md:42`).

**Pergunta à controladora.** A TopConta precisa saber a distribuição por sexo e por faixa etária da base de clientes? Se
sim, para quê?

| Opção | O que significa | Impacto no código | Impacto fora do código |
|-------|-----------------|-------------------|------------------------|
| **A. Cortar `sexo`** (recomendada) | O CRM deixa de receber o dado; a faixa etária só fica se for declarada | Remover a entrada `sexo` de `CARD_ACCOUNT_FIELDS` (`frontend/src/utils/importFields.ts:60`), a chave de `CardAccountRow` e a linha de `prepareRow` (`backend/src/services/cardAccountImport.ts:50` e `:237`) e o bloco `porSexo` de `GET /api/dashboard/perfil` e do `Dashboard.tsx`. Incluir `"sexo" = NULL` em `backend/prisma/sql/2026-10-lgpd-minimizacao-dados.sql`, rodado só depois da confirmação do item 18. A retenção já anula o campo (`retention.ts:145`) | Tirar sexo da op. 3 do registro de operações. Se a faixa etária ficar, declarar essa finalidade no aviso |
| **B. Manter como perfil demográfico agregado** | Sexo e faixa etária continuam, só para estatística interna da base | Nenhuma mudança obrigatória. Opcional: campo por Tenant para habilitar o perfil demográfico, junto com os campos opcionais de importação sugeridos em 01-01 (o card só aparece se habilitado) | Declarar a finalidade "perfil demográfico agregado da base" no aviso de privacidade (linha da data de nascimento e linha nova para sexo) e na op. 3 do registro de operações; avaliar a base legal na LIA ([art. 10](../../fontes/lei-13709.md#art-10)) |
| C. Cortar `sexo` e a faixa etária | Nascimento fica só para o aniversário | Opção A mais a remoção do bloco de faixa etária em `dashboard.ts:326-336` e no card | Aviso e registro ficam como estão para o nascimento |

**Recomendação: opção A.** Nenhuma decisão de negócio usa sexo hoje, então o dado não passa pelo teste de necessidade do
art. 6º, III. Cortar sai mais barato do que justificar no aviso e na LIA. A faixa etária pode ficar se a controladora a
quiser para conhecer a base, desde que declarada; senão, opção C.

**Prazo sugerido.** Junto com a confirmação do item 18 de [`pendencias-fora-do-codigo.md`](../../pendencias-fora-do-codigo.md),
antes de rodar o SQL destrutivo, para não precisar de uma segunda limpeza.

## Escolhas da controladora que aparecem dentro dos achados de código

Não são achados de decisão, mas a correção tem um ponto em que a controladora pode querer opinar:

- **05-09 (lista de destinatários):** quais papéis podem ver nome e valores financeiros dos destinatários de campanha. A
  correção padrão aplica a mesma regra da lista de clientes (VIEWER sem nome e sem valores); se a controladora quiser
  outra, vira configuração por Tenant.
- **05-01 (parcial, export):** se OPERATOR e ANALYST continuam exportando CSV (hoje com telefone mascarado).
- **02-09 e 03-09 (pedidos do titular):** por quais canais a TopConta aceita pedido de descadastro e de eliminação
  (telefone, e-mail, WhatsApp) e quem na equipe registra. O código passa a aplicar o pedido; o canal e o responsável são da
  controladora e devem constar no aviso de privacidade ([art. 18, §3º](../../fontes/lei-13709.md#art-18)).

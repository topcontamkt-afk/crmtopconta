# 02 · Base legal, consentimento e legítimo interesse

Dispositivos centrais: [art. 7º](../../../../docs/lgpd/fontes/lei-13709.md#art-7) (hipóteses),
[art. 8º](../../../../docs/lgpd/fontes/lei-13709.md#art-8) (consentimento: prova, finalidade determinada,
revogação gratuita e facilitada), [art. 9º](../../../../docs/lgpd/fontes/lei-13709.md#art-9),
[art. 10](../../../../docs/lgpd/fontes/lei-13709.md#art-10) (legítimo interesse: finalidade concreta,
mínimo necessário, transparência, RIPD a pedido), [art. 18, §2º](../../../../docs/lgpd/fontes/lei-13709.md#art-18)
(oposição), [Guia de Legítimo Interesse](../../../../docs/lgpd/fontes/anpd-guia-legitimo-interesse.md)
(teste de balanceamento: finalidade, necessidade, balanceamento e salvaguardas).

Contexto fixo: a controladora (TopConta) **não formalizou** a base legal dos disparos. O produto deve
suportar vários controladores, cada um com sua base. Essa dimensão não decide a base: ela mostra o que o
código precisa ter para **qualquer** das duas rotas plausíveis (consentimento ou legítimo interesse) e
aponta o que falta hoje.

## Checklist

| # | Pergunta verificável | Onde olhar |
|---|----------------------|------------|
| 02.1 | Existe registro **por tratamento ou finalidade** da base legal usada (campo, configuração por tenant, enum)? Ou o sistema assume uma base implícita? | `backend/prisma/schema.prisma` (`Tenant`, `Client`, `Campaign`), `backend/src/routes/tenant.ts` |
| 02.2 | `Client.autorizacaoComunicacao`: de onde vem o valor (coluna da planilha? default?), o que significa, e se é **checado antes de enviar**. Um default `true`, ou a ausência de checagem, quebra a prova de consentimento (art. 8º, §2º: ônus da prova é do controlador). | `schema.prisma`, `services/importService.ts`, `services/cardAccountImport.ts` (há comentário sobre "base legal" ~l.253), `services/campaignQueue.ts`, `services/automationEngine.ts`, `services/whatsappReply.ts` |
| 02.3 | Se a rota for consentimento: o sistema guarda **prova** (quando, por qual canal, qual texto ou versão de termo, para qual finalidade)? Um booleano não basta. | idem 02.2, `AuditLog` |
| 02.4 | Campanha manual (planilha) exige `consentimento: true` digitado pelo operador. Isso registra **quem** declarou, quando e sobre qual lista, de forma auditável? É declaração do operador, não do titular: ok como salvaguarda, mas não substitui a base. | `backend/src/routes/campaigns.ts` (~l.57–91), `frontend/src/pages/campaigns/CampaignWizard.tsx` (~l.499), `middleware/audit.ts` |
| 02.5 | Se a rota for legítimo interesse: a **primeira mensagem** informa a identidade do controlador e como parar (transparência, art. 10, §2º; Guia LI, salvaguardas)? Templates aprovados trazem rodapé de opt-out? Há algo no código que **garante** isso ou depende do texto digitado? | `services/templateVariables.ts`, `services/whatsappTemplates.ts`, `services/campaignWizard.ts` (validações) |
| 02.6 | Revogação e oposição: as palavras de opt-out cobrem as formas usuais em pt-BR? O opt-out vale para **todos os canais** (WhatsApp e SMS) e para automações, lista manual e respostas da inbox? A revogação é tão fácil quanto o consentimento (art. 8º, §5º)? | `services/whatsappPayload.ts` (~l.138–169), `services/whatsappInbox.ts` (~l.153), `services/channels/sms.ts`, `services/campaignQueue.ts`, `services/manualCampaign.ts`, `services/automationEngine.ts` |
| 02.7 | Há canal de opt-out **por SMS** (STOP/PARAR inbound), ou só por WhatsApp? | `backend/src/routes/integrations.ts` (webhook SMS ~l.434) |
| 02.8 | Automações (cliente novo, inativo 30 dias, limite renovado, faixa de uso, ciclo) disparam mensagem **sem ação humana**. A base que cobre a campanha cobre também a automação, ou a finalidade é outra? Registre como `decisao_negocio` quando depender da controladora. | `services/automationEngine.ts`, model `AutomationRule` |
| 02.9 | Decisão automatizada (art. 20): algum fluxo decide algo que afeta o titular **só por algoritmo** (bloqueio, elegibilidade, tier) e tem efeito externo? Se só segmenta marketing, registre como `ok` com justificativa. | `services/usage.ts`, `services/etapaUso.ts`, `services/opportunities.ts`, `services/automationEngine.ts` (ação BLOQUEAR) |

## Saída esperada desta dimensão

Além dos achados, um item `decisao_negocio` consolidado: **"Definir base legal dos disparos de
marketing"**, com as duas rotas, o que cada uma exige do código (lista de mudanças) e uma recomendação
fundamentada no Guia LI. A base declarada da controladora vira configuração do `Tenant`.

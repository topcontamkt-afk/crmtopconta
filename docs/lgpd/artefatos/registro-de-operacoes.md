# Registro das operações de tratamento (art. 37)

> **RASCUNHO — requer revisão jurídica.** Preparado pelo operador a partir do código; a controladora completa e
> aprova as colunas de base legal e de prazo. Não é parecer jurídico. Achado 08-05 da
> [auditoria de 2026-10-18](../auditoria/2026-10-18/relatorio.md).

Controlador e operador mantêm registro das operações que realizam ([LGPD art. 37](../fontes/lei-13709.md#art-37)). O
modelo simplificado da [Res. 2/2022, Anexo I, art. 9º](../fontes/anpd-res-02-2022-pequeno-porte.md#anexo-i-art-9) só
cabe se o tratamento não for de alto risco ([art. 3º](../fontes/anpd-res-02-2022-pequeno-porte.md#anexo-i-art-3) e
[art. 4º](../fontes/anpd-res-02-2022-pequeno-porte.md#anexo-i-art-4)). Os insumos de alto risco (renda, perfil de
consumo, idade, escala) estão na seção 3 de [fora-do-codigo.md](../auditoria/2026-10-18/fora-do-codigo.md).

## Identificação

| Campo | Valor |
|-------|-------|
| Controlador | {{Tenant.controladorNome}} (TopConta) |
| Encarregado | {{Tenant.encarregadoNome}} — {{Tenant.encarregadoContato}} (**a nomear**) |
| Operadores | Contratado que opera os disparos; quem desenvolve e hospeda o CRM |
| Suboperadores | Ver [suboperadores.md](suboperadores.md) |
| Sistema | CRM TopConta (`backend/` + `frontend/`) |
| Data desta versão | 2026-10-18 |

Valores `{{...}}` são configurados por tenant em Configurações → LGPD. Outro controlador que use o CRM mantém o próprio
registro com estas mesmas linhas.

## Titulares

1. **Clientes** do cartão de benefícios da controladora (importados da planilha da controladora).
2. **Não clientes** de listas manuais de campanha (só com consentimento declarado e prova; decisão 1 da
   [triagem](../auditoria/2026-10-18/triagem.md)).
3. **Usuários internos** do CRM (equipe da controladora e operadores).

## Operações

Bases legais marcadas *(sugerida)* são a recomendação técnica da triagem; a decisão é da controladora.

| # | Operação | Dados | Finalidade | Base legal | Fonte | Compartilhamento | Retenção |
|---|----------|-------|------------|------------|-------|------------------|----------|
| 1 | Importação e atualização da base | Nome, CPF (só hash e versão mascarada), telefone, cidade, empresa conveniada, data de cadastro e abertura, validade do cartão, status e data de encerramento | Gestão do relacionamento com o cliente do cartão | Execução de contrato, [art. 7º, V](../fontes/lei-13709.md#art-7) *(sugerida)* | Planilha Google ou CSV da controladora | Google (leitura) | Enquanto ativo; anonimização após `Tenant.retentionDays` (padrão 1095) sem uso, ou após `retentionDaysAfterClosure` do encerramento |
| 2 | Dados financeiros do cartão | Limite, valor utilizado, saldo disponível, valor antecipado, datas e contagem de uso; percentual e faixa de uso | Mostrar uso do cartão e segmentar comunicação | Execução de contrato *(sugerida)*; para marketing, ver op. 5 | Planilha da controladora | — | Igual à op. 1 |
| 3 | Perfil demográfico | Data de nascimento, sexo, remuneração bruta e líquida | Aniversário: mensagem de felicitação. Renda: **só estatística agregada**, fora de filtros e segmentos (decisão 2) | Legítimo interesse, [art. 7º, IX](../fontes/lei-13709.md#art-7) *(sugerida)* | Planilha da controladora | — | Igual à op. 1 |
| 4 | Histórico de compras | Estabelecimento, categoria, valor e data | Perfil de uso por categoria para ofertas | Legítimo interesse *(sugerida)*; avaliar no RIPD | Planilha da controladora | — | Igual à op. 1 |
| 5 | Campanhas de marketing (WhatsApp, SMS) | Telefone, nome e variáveis do template; status de entrega e leitura | Comunicação comercial com o cliente | `Tenant.baseLegalMarketing` — TopConta: legítimo interesse *(sugerida)*, com [LIA](lia-template.md). Lista de não clientes: consentimento, [art. 7º, I](../fontes/lei-13709.md#art-7) | Base do CRM | Meta, Z-API, Twilio, Zenvia | Eventos de envio: {{a definir}} |
| 6 | Automações | Mesmos dados da op. 5, mais gatilhos (novo cliente, reativação, limite renovado, faixa de uso) | Disparos automáticos por regra | Igual à op. 5 | Base do CRM | Igual à op. 5 | Igual à op. 5 |
| 7 | Atendimento WhatsApp (inbox) | Telefone, nome do perfil WhatsApp, mensagens e mídias trocadas | Responder ao cliente | Execução de contrato / legítimo interesse *(sugerida)* | O próprio titular | Meta, Z-API | Mensagens: `Tenant.inboxRetentionDays`; mídias: `Tenant.mediaRetentionDays` (padrão 90) |
| 8 | Ligações com assistente virtual | Telefone, nome, cidade, saldo disponível, áudio da conversa | Avisar o saldo e incentivar o uso | Igual à op. 5 | Base do CRM | Twilio, xAI | Áudio não é gravado pelo CRM; transcrição só em log se `VOICE_LOG_TRANSCRIPT=1` |
| 9 | Opt-out e supressão | Hash do telefone e do documento, motivo, canal, data | Respeitar a oposição e o bloqueio do titular de forma permanente | Legítimo interesse *(sugerida)*: é a salvaguarda de oposição do LI ([Guia LI, p. 25](../fontes/anpd-guia-legitimo-interesse.md#p-25)); ver também [art. 18, § 2º](../fontes/lei-13709.md#art-18) | Titular | — | Permanente (só hashes) |
| 10 | Pedidos de titular | Tipo do pedido, canal, prazos, resposta, telefone mascarado | Atender aos [arts. 18 e 19](../fontes/lei-13709.md#art-18) | Obrigação legal *(sugerida)* | Titular | — | {{a definir}} |
| 11 | Usuários do CRM e trilha de auditoria | Nome, e-mail, papel, 2FA, ações realizadas | Controle de acesso e prestação de contas ([art. 6º, X](../fontes/lei-13709.md#art-6)) | Legítimo interesse / obrigação legal *(sugerida)* | O próprio usuário | — | {{a definir}} |

## Medidas de segurança ([art. 46](../fontes/lei-13709.md#art-46))

- Isolamento por tenant em duas camadas: filtro em todas as consultas e Row Level Security no Postgres.
- CPF nunca em texto puro: HMAC-SHA256 com sal por tenant, mais versão mascarada.
- Credenciais de canal cifradas com AES-256-GCM (cifragem envelope).
- Login com JWT, bloqueio por tentativas e 2FA opcional; papéis ADMIN, OPERATOR, ANALYST e VIEWER, e acesso por área.
- Trilha de auditoria encadeada por hash (`AuditLog`).
- Telefone mascarado nas telas e exports; logs sem dado pessoal.
- Retenção automática com anonimização diária.

## Manutenção

Revisar este registro a cada operação nova (campo novo importado, canal novo, novo uso de um dado). A skill
`/lgpd-check` aponta mudanças que exigem atualização.

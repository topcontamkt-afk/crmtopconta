# 03 · Direitos do titular

Dispositivos centrais: [art. 6º, IV e VI](../../../../docs/lgpd/fontes/lei-13709.md#art-6) (livre acesso,
transparência), [art. 9º](../../../../docs/lgpd/fontes/lei-13709.md#art-9),
[art. 17](../../../../docs/lgpd/fontes/lei-13709.md#art-17),
[art. 18](../../../../docs/lgpd/fontes/lei-13709.md#art-18) (confirmação, acesso, correção,
anonimização/bloqueio/eliminação, portabilidade, informação sobre compartilhamento, revogação,
oposição), [art. 19](../../../../docs/lgpd/fontes/lei-13709.md#art-19) (prazos: formato simplificado
imediato ou declaração completa em até 15 dias), [art. 20](../../../../docs/lgpd/fontes/lei-13709.md#art-20)
(revisão de decisão automatizada), [art. 41](../../../../docs/lgpd/fontes/lei-13709.md#art-41) (encarregado
recebe reclamações), [Res. 2/2022, Anexo I, art. 11](../../../../docs/lgpd/fontes/anpd-res-02-2022-pequeno-porte.md#anexo-i-art-11)
(canal com o titular, mesmo sem encarregado).

Pergunta-guia: **se um cliente pedir hoje, pelo WhatsApp, "quero saber que dados vocês têm de mim e
quero que apaguem", o operador consegue atender só pelo sistema, dentro do prazo, deixando trilha?**

O CRM é interno (o titular não faz login). Atender direitos significa dar ao **operador** as ferramentas
para responder ao titular, mais um canal pelo qual o titular faça o pedido.

## Checklist

| # | Pergunta verificável | Onde olhar |
|---|----------------------|------------|
| 03.1 | **Confirmação e acesso** (art. 18, I–II): existe forma de localizar um titular por telefone ou CPF (hash) e gerar **relatório de tudo** que existe dele? Inclui `Client`, `Movement`, `AccountSnapshot`, `Purchase`, `MessageEvent`, `Conversation`, `WaMessage`, `CampaignRecipient`, `ImportChange`, `AuditLog`. | `backend/src/routes/clients.ts`, `services/dedupe.ts` (busca por hash), `grep -rn "export" backend/src/routes` |
| 03.2 | **Portabilidade** (art. 18, V): esse relatório sai em formato estruturado e legível por máquina (JSON/CSV)? | idem |
| 03.3 | **Correção** (art. 18, III): edição manual de cliente existe. A próxima importação **sobrescreve** a correção ("last update wins")? Se sim, a correção do titular se perde sem aviso. | `routes/clients.ts` (`PATCH /:id` ~l.112), `services/importService.ts` (merge), `services/cardAccountImport.ts` |
| 03.4 | **Eliminação de um titular** (art. 18, IV e VI; art. 16): existe ação para apagar ou anonimizar **um** cliente em todas as tabelas, sem esperar a retenção? O que existe hoje (purge de todos, retenção por inatividade) não atende pedido individual. E o titular apagado **volta** na próxima sincronização da planilha? Precisa de lista de supressão (hash) que bloqueie a reimportação. | `routes/clients.ts` (`purge` ~l.186), `services/retention.ts`, `services/importService.ts`, `services/googleSheets.ts` |
| 03.5 | **Bloqueio** (art. 18, IV): é possível suspender o tratamento de um titular (sem apagar) enquanto se analisa um pedido? Opt-out bloqueia mensagens, mas não outros tratamentos (segmentos, dashboard, export). | `Client.optOutAt`, `statusConta`, filtros em `services/segments.ts` e `routes/clients.ts` (export) |
| 03.6 | **Informação sobre compartilhamento** (art. 18, VII): o sistema sabe dizer com quem os dados de um titular foram compartilhados (Meta, Twilio, Zenvia, Google)? `MessageEvent` registra o canal e o provedor? | model `MessageEvent`, `services/channels/*` |
| 03.7 | **Oposição e revogação** (art. 18, §2º e IX): ver 02.6. Aqui verifique só se o pedido fica **registrado** como pedido de titular (data, canal, atendido em), e não apenas como `optOutAt`. | `services/whatsappInbox.ts`, `AuditLog` |
| 03.8 | **Prazo e trilha** (art. 19): existe registro de pedidos de titular com data de entrada e data de resposta, para provar o prazo de 15 dias? | `grep -rni "titular\|solicita" backend/src` |
| 03.9 | **Canal com o titular** (art. 41; Res. 2/2022, Anexo I, art. 11): o canal e a identidade do encarregado são configuráveis por tenant e aparecem para o titular (rodapé de mensagem, resposta automática a "privacidade" ou "LGPD")? | `Tenant`, `services/whatsappReply.ts`, `services/templateVariables.ts` |
| 03.10 | **Revisão de decisão automatizada** (art. 20): se 02.9 encontrou decisão automatizada com efeito, existe como pedir revisão? | ver 02.9 |

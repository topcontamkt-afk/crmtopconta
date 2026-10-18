# Ações fora do código: auditoria LGPD pós-correção de 2026-10-18

Commit: `4e20d5a` (branch `claude/lgpd-adequacao`; produção em `ae033a0`). Achados completos em [relatorio.md](relatorio.md)
e [achados.json](achados.json).

Nesta rodada **nenhum achado novo é do tipo `fora_do_codigo`**. Esta lista reúne: as pendências do item 08.9 do checklist
(contratos, encarregado, RIPD, aviso publicado, política de segurança), que seguem todas abertas; o que ainda falta fora do
código nos achados anteriores PARCIAIS ou ABERTOS; o que os achados novos pedem de procedimento enquanto o código não muda;
e as checagens do operador. O andamento oficial fica em [`pendencias-fora-do-codigo.md`](../../pendencias-fora-do-codigo.md)
(números "nº" abaixo); marque lá, não aqui.

Quem age:

- **Controladora** é a TopConta, que decide finalidade e meios ([LGPD art. 5º, VI](../../fontes/lei-13709.md#art-5)).
- **Operador** é quem trata em nome dela: o contratado que opera os disparos e quem desenvolve e hospeda o CRM
  ([art. 5º, VII](../../fontes/lei-13709.md#art-5); [art. 39](../../fontes/lei-13709.md#art-39)). O operador prepara os
  insumos técnicos de [`artefatos/`](../../artefatos/); assinatura, publicação e decisão são da controladora.

> Não é parecer jurídico. Contratos, nomeação de encarregado e textos públicos devem passar por revisão jurídica.

## 1. Pendências do item 08.9 (governança)

- [ ] **Contrato de operador com quem opera os disparos.** Quem age: **controladora**. Deve fixar instruções, finalidade,
  sigilo, segurança, devolução e eliminação ao fim ([art. 39](../../fontes/lei-13709.md#art-39)). Nº 1.
- [ ] **Contrato de operador com quem desenvolve e hospeda o CRM.** Quem age: **controladora**. Mesmo conteúdo, mais a
  autorização para usar os suboperadores listados. Nº 2.
- [ ] **Termo de confidencialidade de quem acessa dados** (achado 05-06, ABERTO). Quem age: **controladora** (assina com cada
  pessoa); o **operador** pode depois registrar o aceite no sistema, se a controladora pedir
  ([art. 47](../../fontes/lei-13709.md#art-47)). Nº 3.
- [ ] **DPA e mecanismo de transferência internacional com cada suboperador** (Meta, Twilio, Zenvia, Google, Vercel,
  Supabase, Z-API, xAI) (achados 06-03 e 06-04, PARCIAIS). Quem age: **controladora**, com o **operador** fornecendo o
  inventário pronto em [`suboperadores.md`](../../artefatos/suboperadores.md). Mecanismo do
  [art. 33](../../fontes/lei-13709.md#art-33), por exemplo as cláusulas-padrão da
  [Res. 19/2024, Anexo I, art. 17](../../fontes/anpd-res-19-2024-transf-intl.md#anexo-i-art-17). Nº 4.
- [ ] **Nomear o encarregado e publicar o contato.** Quem age: **controladora**. Publicar no site
  ([Res. 18/2024, Anexo, art. 9º](../../fontes/anpd-res-18-2024-encarregado.md#anexo-art-9)) e gravar em Configurações →
  LGPD, de onde sai para a resposta automática e o relatório do titular. Se for agente de pequeno porte, pode não nomear,
  mas precisa de um canal com o titular
  ([Res. 2/2022, Anexo I, art. 11](../../fontes/anpd-res-02-2022-pequeno-porte.md#anexo-i-art-11);
  [art. 41](../../fontes/lei-13709.md#art-41)). Nº 5.
- [ ] **Publicar o aviso de privacidade e gravar a URL** em Configurações → LGPD. Quem age: **controladora**; insumo em
  [`aviso-de-privacidade.md`](../../artefatos/aviso-de-privacidade.md). Antes de publicar, resolver a decisão 01-05 (sexo e
  faixa etária) e incluir os canais aceitos para pedido de descadastro e de eliminação (ver seção 3)
  ([art. 9º](../../fontes/lei-13709.md#art-9)). Nº 6.
- [ ] **Publicar o inventário de suboperadores e a transferência internacional.** Quem age: **controladora**. Nº 7.
- [ ] **Aprovar o registro das operações de tratamento** (achado 08-05, PARCIAL). Quem age: **controladora e operador**;
  rascunho em [`registro-de-operacoes.md`](../../artefatos/registro-de-operacoes.md), que já cobre Z-API, Twilio Voz e xAI.
  Ajustar a op. 3 conforme a decisão 01-05 ([art. 37](../../fontes/lei-13709.md#art-37)). Nº 8.
- [ ] **Avaliar alto risco e elaborar o RIPD** (achado 08-06, ABERTO). Quem age: **controladora**. Os critérios seguem no
  código: nascimento, sexo e renda no cadastro, renda estimada PF1–PF4, perfil de consumo por categoria, gatilho automatizado
  `ETAPA_PERFIL` e agente de voz com IA. Atenuante: renda deixou de ser critério de público
  ([art. 38](../../fontes/lei-13709.md#art-38)). Insumos na
  [seção 3 da rodada completa](../2026-10-18/fora-do-codigo.md#3-documentos-de-governança). Nº 9.
- [ ] **Aprovar a LIA e gravar versão e data** em Configurações → LGPD. Quem age: **controladora**; modelo em
  [`lia-template.md`](../../artefatos/lia-template.md) ([art. 10](../../fontes/lei-13709.md#art-10)). Nº 10.
- [ ] **Política de segurança da informação.** Quem age: **controladora**, com as medidas técnicas descritas pelo
  **operador** no registro de operações. Pode ser simplificada para pequeno porte
  ([Res. 2/2022, Anexo I, art. 13](../../fontes/anpd-res-02-2022-pequeno-porte.md#anexo-i-art-13);
  [art. 46](../../fontes/lei-13709.md#art-46); [art. 50](../../fontes/lei-13709.md#art-50)). Nº 11.
- [ ] **Aprovar o procedimento de incidentes e avaliar os 3 eventos já registrados** (achado 05-04, fechado na parte do
  operador). Quem age: **controladora**. Na revisão, o **operador** ajusta duas coisas vistas nesta rodada: o procedimento
  cita "notificações de login bloqueado", que o sistema não gera (o evento fica só no AuditLog), e a tabela de registro deve
  separar os itens do [Res. 15/2024, Anexo, art. 10](../../fontes/anpd-res-15-2024-incidentes.md#anexo-art-10). Enquanto 05-08
  não for corrigido, uma divergência na cadeia de hash pode ser provocada por terceiro e não prova adulteração sozinha. Nº 12.
- [ ] **Fundamento do prazo de retenção e do prazo pós-encerramento.** Quem age: **controladora** (o sistema já exige o
  texto ao mudar o prazo) ([art. 15](../../fontes/lei-13709.md#art-15); [art. 16](../../fontes/lei-13709.md#art-16)). Nº 17.
- [ ] **Confirmar que nenhum campo cortado por minimização tem uso** antes do SQL destrutivo. Quem age: **controladora**,
  junto com a decisão 01-05 ([decisoes-pendentes.md](decisoes-pendentes.md)). Nº 18.

## 2. Resto fora do código dos achados anteriores

- [ ] **Z-API: decidir o uso, contrato e política do celular pareado** (04-08 e 06-04, PARCIAIS). Quem age: a
  **controladora** decide e instrui por escrito; o **operador** aplica e confirma se a Z-API está ativa em produção (nº 14).
  Detalhes na [seção 1 do delta](../2026-10-18-delta/fora-do-codigo.md#1-z-api-conexão-whatsapp-não-oficial).
- [ ] **Voz (Twilio + xAI): DPA antes da fase 2.** Quem age: **controladora**. Hoje a ligação só vai ao celular de teste, sem
  titular real. Detalhes na [seção 2 do delta](../2026-10-18-delta/fora-do-codigo.md#2-ligações-por-ia-de-voz-twilio-voice--xai).
- [ ] **Base legal da TopConta salva por um ADMIN da controladora.** Quem age: **controladora**. A base foi declarada pelo SQL
  de adequação, sem autor no AuditLog; salvar Configurações → LGPD grava `UPDATE_TENANT_LGPD` encadeado. Pendência conhecida
  ("Decidir depois").

## 3. Procedimento enquanto os achados novos não forem corrigidos

Estes itens não substituem a correção de código; evitam que o pedido do titular fique sem efeito no meio tempo.

- [ ] **Descadastro recebido fora do WhatsApp/SMS (02-09).** Quem age: **operador** (ADMIN do CRM). Não fechar pedido
  REVOGACAO/OPOSICAO como ATENDIDO só pela tela de pedidos. Para cliente da base, aplicar antes o opt-out manual pela API
  existente (`PATCH /api/clients/:id` com `autorizacaoComunicacao: false`, que grava a supressão por telefone,
  `backend/src/routes/clients.ts:367-369`) e só então fechar. Para contato de lista fora da
  base não há caminho no sistema: deixar o pedido aberto e escalar para correção. Prazo de resposta: 15 dias
  ([art. 19](../../fontes/lei-13709.md#art-19)).
- [ ] **Acesso e eliminação de quem não é cliente (03-09).** Quem age: **operador**, com ciência da **controladora**. O
  sistema não atende; montar a resposta de acesso à mão a partir da Inbox e da lista de destinatários, e registrar no pedido
  o que foi feito. Não fechar ELIMINACAO como ATENDIDO enquanto conversa e destinatário com aquele número existirem
  ([art. 18](../../fontes/lei-13709.md#art-18)).
- [ ] **Canais aceitos para pedido do titular.** Quem age: **controladora**. Definir por onde aceita descadastro e eliminação
  (telefone, e-mail, WhatsApp) e quem registra no CRM; publicar no aviso de privacidade.

## 4. Checagens do operador

- [ ] Confirmar a região da Vercel e do Supabase (nº 13). As ferramentas usadas na auditoria não informam a região.
- [ ] Confirmar se a Z-API está ativa em produção (nº 14).
- [ ] Confirmar uma execução real do job de retenção depois do deploy desta branch (nº 15). No plano Hobby o log dura 1 h;
  conferir logo após as 03:00 UTC.
- [ ] Confirmar que o Data API (PostgREST) do Supabase está desligado (nº 16).
- [ ] Confirmar de quem é o celular de formato real em `backend/src/services/voice.test.ts:68-74` e trocá-lo por um número
  fictício se for de uma pessoa (item 07.11).
- [ ] Antes do deploy (lista em [`pendencias-integracao.md`](../../correcoes/pendencias-integracao.md#antes-do-deploy-operador)):
  aplicar `2026-10-lgpd-adequacao.sql`, conferir o WhatsApp configurado pela tela, definir `PLATFORM_DEFAULT_TENANT_ID` se
  houver SMS pelas variáveis, validar o `/clients/purge` e o `UPDATE "Purchase"` sob `app_runtime` + RLS e preencher
  Configurações → LGPD. Também conferir no banco os segmentos salvos como `{"operator":"AND"}` (bug de produção registrado na
  mesma lista), porque campanhas com eles foram para a base enviável inteira.

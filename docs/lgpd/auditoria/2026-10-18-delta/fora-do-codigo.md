# Ações fora do código: auditoria LGPD incremental de 2026-10-18 (delta)

Commit: `0e47151` (código de `backend/` e `frontend/` idêntico a `ae033a0`; intervalo auditado `ce578a6..ae033a0`).
Achados completos em [relatorio.md](relatorio.md) e [achados.json](achados.json).

Esta lista reúne o que nenhuma mudança no código resolve e que surgiu ou mudou com o delta: os 2 achados do tipo
`fora_do_codigo` desta rodada (04-08 e 06-04) e as pendências do item 08.9 do checklist (contrato com a Z-API, DPA com a
xAI e a Twilio Voice, Fly.io, aviso e LIA cobrindo as finalidades novas). As pendências da rodada anterior continuam
abertas em [../2026-10-18/fora-do-codigo.md](../2026-10-18/fora-do-codigo.md). A seção 4 só repete as que o delta
amplia.

Quem age:

- **Controladora** é a TopConta, que decide finalidade e meios ([LGPD art. 5º, VI](../../fontes/lei-13709.md#art-5)).
- **Operador** é quem trata em nome dela: o contratado que opera os disparos e quem desenvolve e hospeda o CRM
  ([art. 5º, VII](../../fontes/lei-13709.md#art-5); [art. 39](../../fontes/lei-13709.md#art-39)). O operador prepara
  insumos técnicos; a assinatura, a publicação e a decisão são da controladora.

> Não é parecer jurídico. Contratos, nomeação de encarregado e textos públicos devem passar por revisão jurídica.

## 1. Z-API (conexão WhatsApp não oficial)

- [ ] **Decidir se a Z-API pode ser usada.** Quem age: **controladora**. A integração é uma sessão de WhatsApp Web por
  QR code que viola os termos do WhatsApp. O número pode ser bloqueado, e ele é também o canal de contato e de opt-out do
  titular. Se a resposta for não, o operador desliga a opção para o tenant. Base:
  [art. 39](../../fontes/lei-13709.md#art-39) (o operador segue as instruções da controladora) e
  [art. 46](../../fontes/lei-13709.md#art-46). Item 08.9.
- [ ] **Contrato operador ↔ suboperador com a Z-API.** Quem age: **controladora**, ou o **operador** se a conta da Z-API
  estiver em nome dele, sempre com aprovação da controladora. O contrato deve cobrir: a Z-API recebe todas as mensagens do
  número conectado, inclusive as que o CRM descarta; guarda o link das mídias no CDN por cerca de 30 dias; o país de
  processamento (não aparece no código); e a eliminação ao fim do contrato. Se o processamento for fora do Brasil, é
  preciso um mecanismo do [art. 33](../../fontes/lei-13709.md#art-33), como as cláusulas-padrão da
  [Res. 19/2024](../../fontes/anpd-res-19-2024-transf-intl.md#anexo-i-art-17). Achado 06-04; item 08.9.
- [ ] **Política do celular pareado.** Quem age: a **controladora** define e instrui por escrito
  ([art. 39](../../fontes/lei-13709.md#art-39)); o **operador** aplica e confirma. O histórico e as mídias ficam no
  aparelho, fora de qualquer retenção do CRM ([art. 15](../../fontes/lei-13709.md#art-15),
  [art. 16](../../fontes/lei-13709.md#art-16)). Recomendação: aparelho dedicado e corporativo; temporizador padrão de
  mensagens temporárias do WhatsApp ligado, com prazo igual ou menor que o do CRM (ex.: 90 dias); registro de quem guarda
  o aparelho; despareamento e apagamento dos dados ao fim do contrato ou do uso. "Desconectar" no CRM só apaga as
  credenciais e não limpa o aparelho. Achado 04-08.
- [ ] **Incluir a Z-API e o aparelho pareado no procedimento de eliminação.** Quem age: **controladora** (procedimento),
  com o **operador** executando. Quando um titular pedir eliminação, o pedido precisa alcançar também a Z-API e o
  aparelho ([art. 18, §6º](../../fontes/lei-13709.md#art-18)). Depende do procedimento de 03-01 da rodada anterior.
  Cobertura 03 (extra).

## 2. Ligações por IA de voz (Twilio Voice + xAI)

Hoje a voz só liga para o celular de teste da equipe, então nenhum titular é alcançado. Os itens abaixo são condição para
abrir a voz aos clientes, como já planejam as pendências do CLAUDE.md.

- [ ] **DPA e mecanismo de transferência com a xAI.** Quem age: **controladora**. A conta é hoje global do operador
  (`XAI_API_KEY`), então o **operador** formaliza o contrato em nome da controladora ou migra para uma conta dela. A xAI
  fica nos EUA e recebe o áudio da ligação, a transcrição e o nome e saldo ditos pelo agente. Precisa de mecanismo do
  [art. 33](../../fontes/lei-13709.md#art-33) (cláusulas-padrão da
  [Res. 19/2024, Anexo I, art. 17](../../fontes/anpd-res-19-2024-transf-intl.md#anexo-i-art-17) ou outro) antes de
  qualquer ligação a cliente real. Achado 06-04; item 08.9.
- [ ] **Twilio Voice no contrato com a Twilio.** Quem age: **controladora**. O DPA com a Twilio, já pendente para o SMS
  na rodada anterior, deve cobrir também as chamadas de voz: número chamado e TwiML com nome e saldo. Achado 06-04; item
  08.9.
- [ ] **Fly.io, se o servidor de áudio for para lá.** Quem age: **controladora**, com o **operador** informando a
  região. Será mais um suboperador, que precisa de contrato e entra no inventário. Item 08.9.

## 3. Transparência ao titular

- [ ] **Atualizar e publicar o inventário de suboperadores.** Quem age: a **controladora** publica e o **operador** entrega
  a lista técnica. Destinos novos: Z-API (`api.z-api.io` e o CDN de mídia), xAI (`api.x.ai`), Twilio Voice
  (`api.twilio.com`, chamadas) e Fly.io, quando adotado. Para cada um: dado enviado, finalidade, país e mecanismo do
  [art. 33](../../fontes/lei-13709.md#art-33). Com cláusulas-padrão, a controladora publica país, finalidade e agentes
  em linguagem simples ([Res. 19/2024, Anexo I, art. 17](../../fontes/anpd-res-19-2024-transf-intl.md#anexo-i-art-17)).
  O `docs/lgpd/README.md` ainda lista só Meta, Twilio, Zenvia, Google, Vercel e Supabase. Achado 06-04 (agrava 06-03).
- [ ] **Aviso de privacidade e LIA cobrindo as finalidades novas.** Quem age: **controladora**. As finalidades novas são a
  campanha enviada pela Z-API, a resposta automática da Inbox e as ligações por IA de voz, incluindo o uso da transcrição.
  Depende da decisão 1 da [triagem](../2026-10-18/triagem.md) (legítimo interesse). Base:
  [art. 9º](../../fontes/lei-13709.md#art-9), [art. 10](../../fontes/lei-13709.md#art-10),
  [Guia LI, p. 52](../../fontes/anpd-guia-legitimo-interesse.md#p-52). Item 08.9.
- [ ] **Definir o texto da resposta automática e o canal do titular que ela indica.** Quem age: a **controladora** define
  o texto, a identificação dela e o canal de privacidade ou do encarregado; o **operador** grava na configuração do
  tenant. Enquanto isso não existir, o código deixa a resposta automática desligada em contas novas. Base:
  [art. 9º](../../fontes/lei-13709.md#art-9), [art. 41](../../fontes/lei-13709.md#art-41),
  [Res. 2/2022, Anexo I, art. 11](../../fontes/anpd-res-02-2022-pequeno-porte.md#anexo-i-art-11). Achado 02-08.

## 4. Governança: pendências anteriores ampliadas pelo delta

- [ ] **RIPD cobrindo a voz por IA.** Quem age: **controladora**; o operador fornece os critérios técnicos. O agente de voz
  com transcrição automática é tecnologia emergente
  ([Res. 2/2022, Anexo I, art. 4º](../../fontes/anpd-res-02-2022-pequeno-porte.md#anexo-i-art-4)) e se soma à larga
  escala já apontada. O RIPD segue o [art. 38](../../fontes/lei-13709.md#art-38) e deve estar pronto antes de abrir a voz
  aos clientes. Achado anterior 08-06; cobertura 08.7.
- [ ] **Registro das operações com os destinos novos.** Quem age: **controladora e operador**
  ([art. 37](../../fontes/lei-13709.md#art-37)). Incluir o envio e o recebimento pela Z-API, a resposta automática e as
  ligações por voz. Achado anterior 08-05; cobertura 08.2.
- [ ] **Procedimento de incidente cobrindo as fontes novas.** Quem age: a **controladora** aprova; o **operador** redige.
  As fontes novas são o sequestro ou o bloqueio da sessão Z-API, um vazamento no CDN da Z-API e falhas na xAI ou na Twilio
  Voice. Base: [art. 48](../../fontes/lei-13709.md#art-48),
  [Res. 15/2024, Anexo, art. 6º](../../fontes/anpd-res-15-2024-incidentes.md#anexo-art-6). Achado anterior 05-04;
  cobertura 05.7.
- [ ] **Seguem abertas, sem mudança:** contrato controladora ↔ operador (com o contratado que opera os disparos e com
  quem desenvolve e hospeda), nomeação e publicação do encarregado, publicação do aviso de privacidade e política de
  segurança da informação. Ver [../2026-10-18/fora-do-codigo.md](../2026-10-18/fora-do-codigo.md). Item 08.9.

## 5. Checagens manuais

Itens que a varredura não conseguiu verificar com as ferramentas permitidas. Quem age: **operador**, que repassa o
resultado à controladora.

- [ ] **A Z-API está pareada em produção?** A produção tem uma só linha em `WhatsAppAccount`, o que é compatível com só a
  Meta configurada. Confirmar no painel do CRM ou da Z-API. Se estiver pareada, os itens da seção 1 passam a ser
  urgentes. Achados 04-08 (PLAUSIBLE) e 06-04.
- [ ] **Há usuários com área restrita em produção?** Isso define quem esteve exposto ao contorno do achado 05-07 até a
  correção. Confirmar na tela Usuários → Acessos.
- [ ] **Região das funções na Vercel (inclusive `api/voice-bridge`) e do projeto Supabase.** `backend/vercel.json` não
  declara `regions`. Item 06.2.
- [ ] **Execução do job de retenção em produção.** O plano Hobby guarda só 1 hora de log. Item 04.7.
- [ ] **Número com formato real em `backend/src/services/voice.test.ts`.** Confirmar que é o celular de teste da equipe e
  trocá-lo por um placeholder. Item 07.11.

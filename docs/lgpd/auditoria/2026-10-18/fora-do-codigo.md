# Ações fora do código: auditoria LGPD de 2026-10-18

Commit auditado: `c3f09cd`. Achados completos em [relatorio.md](relatorio.md) e [achados.json](achados.json).

Esta lista reúne o que nenhuma mudança no código resolve: os 5 achados do tipo `fora_do_codigo` (05-04, 05-06, 06-03,
08-05, 08-06) e as pendências do item 08.9 do checklist, que o grep não encontrou no repositório (contratos, DPAs, RIPD,
aviso de privacidade, política de segurança). Pode ser que alguns desses documentos já existam fora do repositório. Nesse
caso, basta marcar o item e guardar uma referência em `docs/lgpd/artefatos/`.

Quem age:

- **Controladora** é a TopConta, que decide finalidade e meios ([LGPD art. 5º, VI](../../fontes/lei-13709.md#art-5)).
- **Operador** é quem trata em nome dela: o contratado que opera os disparos e quem desenvolve e hospeda o CRM
  ([art. 5º, VII](../../fontes/lei-13709.md#art-5); [art. 39](../../fontes/lei-13709.md#art-39)). O operador prepara
  insumos técnicos; a assinatura, a publicação e a decisão são da controladora.

> Não é parecer jurídico. Contratos, nomeação de encarregado e textos públicos devem passar por revisão jurídica.

## 1. Contratos e cadeia de tratamento

- [ ] **Contrato controladora ↔ operador com o contratado que opera os disparos.** Quem age: **controladora** (redige e
  assina; o operador assina). Deve conter as instruções de tratamento, o que ele pode exportar, o dever de sigilo e o prazo
  para avisar incidentes. Base: [art. 39](../../fontes/lei-13709.md#art-39), [art. 42](../../fontes/lei-13709.md#art-42).
  Item 08.9.
- [ ] **Contrato controladora ↔ operador com quem desenvolve e hospeda o CRM.** Quem age: **controladora**. Mesmo
  conteúdo, mais quem contrata e administra as contas de Vercel, Supabase e Google Cloud. Base:
  [art. 39](../../fontes/lei-13709.md#art-39). Item 08.9.
- [ ] **Termo de confidencialidade para quem acessa dados de clientes.** Quem age: **controladora** (redige o termo e o
  inclui nos contratos acima). Opcional no código: aceite registrado no primeiro login (`User.confidentialityAcceptedAt`),
  a cargo do operador. Base: [art. 47](../../fontes/lei-13709.md#art-47), [art. 6º, X](../../fontes/lei-13709.md#art-6).
  Achado 05-06.
- [ ] **DPA e mecanismo de transferência internacional com cada suboperador.** Quem age: **controladora**, ou o operador
  quando a conta do provedor estiver em nome dele, sempre com aprovação da controladora. Provedores encontrados no código:
  Meta (WhatsApp Cloud API), Twilio, Zenvia, Google (Sheets API), Vercel e Supabase. Para cada um, confirmar o DPA e o
  mecanismo do [art. 33](../../fontes/lei-13709.md#art-33) (cláusulas-padrão da
  [Res. 19/2024](../../fontes/anpd-res-19-2024-transf-intl.md#anexo-i-art-17) ou outro). Zenvia, se processar no Brasil,
  entra só como operador. Se a Z-API estiver mesmo em produção (ver seção 5), ela entra nesta lista. Item 08.9.

## 2. Encarregado e transparência ao titular

- [ ] **Nomear o encarregado e publicar identidade e contato.** Quem age: **controladora**. A divulgação é pública, de
  preferência no site da controladora ([art. 41](../../fontes/lei-13709.md#art-41);
  [Res. 18/2024, Anexo, art. 8º](../../fontes/anpd-res-18-2024-encarregado.md#anexo-art-8) e
  [art. 9º](../../fontes/anpd-res-18-2024-encarregado.md#anexo-art-9)). A dispensa para agente de pequeno porte exige um
  canal de comunicação com o titular ([Res. 2/2022, Anexo I, art. 11](../../fontes/anpd-res-02-2022-pequeno-porte.md#anexo-i-art-11))
  e provavelmente não se aplica (ver o RIPD, seção 3). Depois da nomeação, o operador grava o contato na configuração do
  tenant (achado 03-06). Item 08.9.
- [ ] **Publicar o aviso de privacidade.** Quem age: **controladora** (texto e publicação); o operador fornece a lista de
  dados, finalidades, compartilhamentos e prazos que o sistema pratica. Deve cobrir as informações do
  [art. 9º](../../fontes/lei-13709.md#art-9), inclusive os critérios de segmentação, que o titular pode pedir
  ([art. 20](../../fontes/lei-13709.md#art-20)). Item 08.9.
- [ ] **Publicar o inventário de suboperadores e a informação sobre transferência internacional.** Quem age:
  **controladora** (publica); o **operador** entrega a lista técnica: destino, dado enviado, finalidade e país. Quando a
  base for cláusulas-padrão, a controladora publica em linguagem simples o país de destino, a finalidade e os agentes
  ([Res. 19/2024, Anexo I, art. 17](../../fontes/anpd-res-19-2024-transf-intl.md#anexo-i-art-17) e
  [art. 32](../../fontes/anpd-res-19-2024-transf-intl.md#anexo-i-art-32)). Rascunho sugerido em
  `docs/lgpd/artefatos/suboperadores.md`. Achado 06-03.

## 3. Documentos de governança

- [ ] **Registro das operações de tratamento.** Quem age: **controladora e operador**, porque o
  [art. 37](../../fontes/lei-13709.md#art-37) obriga os dois. Conteúdo mínimo por operação: dado, finalidade, base legal,
  fonte, compartilhamento, retenção e medidas de segurança. O modelo simplificado
  ([Res. 2/2022, Anexo I, art. 9º](../../fontes/anpd-res-02-2022-pequeno-porte.md#anexo-i-art-9)) só vale se couber o regime
  de pequeno porte. Rascunho em `docs/lgpd/artefatos/`. Achado 08-05.
- [ ] **Avaliar se o tratamento é de alto risco e elaborar o RIPD.** Quem age: **controladora**; o operador fornece os
  critérios técnicos que o código aplica. Insumos encontrados: renda estimada e remuneração, perfil de consumo por categoria
  de estabelecimento (inclui farmácia), automação por perfil que oferta antecipação salarial com juros, data de nascimento
  (idosos) e escala de milhares de titulares
  ([Res. 2/2022, Anexo I, art. 4º](../../fontes/anpd-res-02-2022-pequeno-porte.md#anexo-i-art-4)). Se for alto risco, o
  regime simplificado não se aplica ([art. 3º](../../fontes/anpd-res-02-2022-pequeno-porte.md#anexo-i-art-3)). O RIPD
  segue o conteúdo mínimo do [art. 38](../../fontes/lei-13709.md#art-38) e serve de demonstração de avaliação de risco
  ([art. 50](../../fontes/lei-13709.md#art-50)). Achado 08-06.
- [ ] **LIA (teste de legítimo interesse), se a base escolhida for legítimo interesse.** Quem age: **controladora**. Depende
  da decisão 1 de [decisoes-pendentes.md](decisoes-pendentes.md) (achado 02-01). Referências:
  [art. 10](../../fontes/lei-13709.md#art-10), [Guia LI, p. 26](../../fontes/anpd-guia-legitimo-interesse.md#p-26).
- [ ] **Política de segurança da informação.** Quem age: **controladora**, com o **operador** descrevendo as medidas
  técnicas já em vigor (JWT com 2FA, RLS por tenant, cifragem de credenciais, trilha de auditoria encadeada). Base:
  [art. 46](../../fontes/lei-13709.md#art-46), [art. 50](../../fontes/lei-13709.md#art-50). Item 08.9.

## 4. Incidentes de segurança

- [ ] **Procedimento de resposta a incidentes.** Quem age: **controladora** (aprova, decide e comunica à ANPD e aos
  titulares); o **operador** redige o rascunho técnico e se compromete a avisar a controladora em prazo curto. Conteúdo:
  papéis, triagem de risco, consultas a rodar no CRM (AuditLog por período e usuário, exports) e o fluxo de comunicação em
  3 dias úteis ([art. 48](../../fontes/lei-13709.md#art-48);
  [Res. 15/2024, Anexo, art. 6º](../../fontes/anpd-res-15-2024-incidentes.md#anexo-art-6) e
  [art. 9º](../../fontes/anpd-res-15-2024-incidentes.md#anexo-art-9)). Rascunho sugerido em
  `docs/lgpd/artefatos/procedimento-incidentes.md`. Achado 05-04.
- [ ] **Registro de incidentes, guardado por 5 anos.** Quem age: **controladora**. Abrir o registro com os eventos já
  conhecidos, mesmo os que se conclua não serem comunicáveis, com os campos do
  [Res. 15/2024, Anexo, art. 10](../../fontes/anpd-res-15-2024-incidentes.md#anexo-art-10): a importação de compras no
  formato de cartões que alterou dados financeiros de clientes (2026-10), a chave de serviço do Supabase esquecida em
  produção e o Preview público apontado pela auditoria de segurança de 2026-08/09 (que o verificador registrou como sem as
  variáveis de banco). Achado 05-04.

## 5. Checagens manuais de infraestrutura

Itens que a varredura não conseguiu verificar com as ferramentas permitidas. Não são documentos, mas também não se resolvem
no código. Quem age: **operador**, que repassa o resultado à controladora.

- [ ] **Região das funções na Vercel e do projeto Supabase.** `backend/vercel.json` não declara `regions`. Confirmar no
  painel. Se for fora do Brasil, a região entra no inventário e no mecanismo de transferência da seção 1
  ([art. 33](../../fontes/lei-13709.md#art-33)). Item 06.2.
- [ ] **Deploy de produção diferente de HEAD.** A produção do backend roda o commit `6fabc33`, fora do histórico de HEAD,
  que acrescenta uma integração Z-API (não oficial) recebendo telefone e texto. Confirmar se ela está ativa, rodar a
  dimensão 06 sobre esse commit e, se confirmada, incluir a Z-API nos contratos e no inventário. Item 06, extra.
- [ ] **Execução do job de retenção em produção.** A configuração está correta, mas o plano Hobby guarda só 1 hora de log.
  Confirmar uma execução real (log drain ou checagem logo após as 03:00). Item 04.7.
- [ ] **Data API (PostgREST) do Supabase desligado.** Pendente desde a auditoria de segurança anterior; confirmar no painel.
  Item 05, infra.

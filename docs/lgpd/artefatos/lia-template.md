# Teste de legítimo interesse (LIA): comunicação comercial com clientes

> **RASCUNHO — requer revisão jurídica.** Modelo pré-preenchido com o que o CRM faz, para a controladora completar,
> decidir e assinar. Não é parecer jurídico. Segue o modelo de três fases do
> [Guia de Legítimo Interesse da ANPD, p. 31](../fontes/anpd-guia-legitimo-interesse.md#p-31) (formulário nas
> [pp. 45 a 52](../fontes/anpd-guia-legitimo-interesse.md#p-45)). Decisão 1 da
> [triagem](../auditoria/2026-10-18/triagem.md); achado 02-01.

Base: [LGPD art. 7º, IX](../fontes/lei-13709.md#art-7) e [art. 10](../fontes/lei-13709.md#art-10). Quando aprovada, a
versão e a data vão para `Tenant.liaVersao` e `Tenant.liaAprovadaEm` (Configurações → LGPD). Enquanto o tenant não declarar
a base legal, o CRM bloqueia envios de marketing.

| Campo | Valor |
|-------|-------|
| Controlador | {{controladorNome}} |
| Versão | {{v1}} |
| Elaborado por / em | {{nome}} / {{data}} |
| Aprovado por / em | {{nome}} / {{data}} |
| Próxima revisão | {{data}} (sugestão: anual ou quando a operação mudar) |

## Fase 1: finalidade ([p. 31](../fontes/anpd-guia-legitimo-interesse.md#p-31))

**Qual é o interesse?** Informar clientes do cartão de benefícios sobre saldo disponível, renovação de limite,
reativação e ofertas da própria TopConta, para aumentar o uso do serviço contratado.

**De quem é o interesse?** Da controladora. {{Há interesse de terceiro? Ex.: estabelecimentos parceiros.}}

**É legítimo?** O interesse é lícito, específico e atual ([art. 10, caput e I](../fontes/lei-13709.md#art-10)): promover
um serviço que o titular já contratou. {{Confirmar que não há conflito com norma setorial, como a regulação de cartões
de benefício ou do consignado.}}

**Situação concreta:** campanhas por WhatsApp e SMS, automações por gatilho (novo cliente, 30 dias sem uso, limite
renovado, faixa de uso) e ligações com assistente virtual.

## Fase 2: necessidade ([p. 32](../fontes/anpd-guia-legitimo-interesse.md#p-32))

Dados usados, e por que cada um é necessário ([art. 10, § 1º](../fontes/lei-13709.md#art-10)):

| Dado | Necessário para | Alternativa menos invasiva? |
|------|-----------------|-----------------------------|
| Nome e telefone | Endereçar a mensagem | Não |
| Saldo, limite e uso do cartão | Conteúdo da mensagem e escolha do público | {{avaliar}} |
| Data de nascimento | Mensagem de aniversário | {{avaliar}} |
| Cidade, empresa conveniada | Segmentação regional e por convênio | {{avaliar}} |
| Histórico de compras por categoria | Ofertas por perfil de uso | {{avaliar; perfil detalhado pede RIPD}} |
| Renda | **Não usada** em público ou segmento, só em estatística agregada (decisão 2) | — |

Campos sem finalidade deixaram de ser importados (decisão 3 da triagem).

## Fase 3: balanceamento e salvaguardas ([p. 32](../fontes/anpd-guia-legitimo-interesse.md#p-32))

**Legítima expectativa** ([art. 10, II](../fontes/lei-13709.md#art-10);
[Guia, pp. 22 a 24](../fontes/anpd-guia-legitimo-interesse.md#p-22)): o titular é cliente ativo do cartão e espera
contato da empresa sobre o próprio serviço. {{O contrato de adesão ou o aviso de privacidade menciona comunicação
comercial? Contato com cliente encerrado ou inativo há muito tempo pesa contra.}}

**Riscos e impactos ao titular:** incômodo por excesso de mensagens; exposição do saldo a terceiro que atenda o telefone;
perfilamento por compras; público vulnerável (idosos, endividados) recebendo ofertas de antecipação com juros.

**Salvaguardas que o CRM já aplica:**

- Opt-out por palavra-chave e pela equipe, permanente e válido entre campanhas e reimportações: meio efetivo de
  oposição ([Guia, p. 25](../fontes/anpd-guia-legitimo-interesse.md#p-25)).
- Rodapé com identificação do controlador e instrução de opt-out em toda mensagem de marketing.
- Janela de deduplicação por campanha e limite de mensagens por minuto.
- Conta encerrada sai de todo uso comercial.
- Assistente de voz confirma a identidade antes de revelar o saldo.
- Renda fora de filtros; anonimização automática por inatividade.
- Atendimento aos pedidos do titular com prazo controlado.

**Salvaguardas adicionais a decidir:** {{frequência máxima por titular por mês; horário de envio; exclusão de faixas
etárias de ofertas de crédito; transparência no aviso de privacidade}}.

## Conclusão

- [ ] O legítimo interesse **prevalece**, com as salvaguardas acima.
- [ ] **Não prevalece** ou é inconclusivo: usar outra base (consentimento) ou não realizar o tratamento
  ([Guia, p. 13](../fontes/anpd-guia-legitimo-interesse.md#p-13)).
- [ ] Tratamento de alto risco: elaborar o RIPD ([art. 38](../fontes/lei-13709.md#art-38);
  [art. 10, § 3º](../fontes/lei-13709.md#art-10)).

Justificativa: {{texto}}

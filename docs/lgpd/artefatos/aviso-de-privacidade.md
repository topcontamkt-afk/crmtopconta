# Aviso de privacidade: clientes do cartão

> **RASCUNHO — requer revisão jurídica.** Texto-base para a controladora adaptar e publicar (site, contrato de adesão ou
> link no rodapé das mensagens). Não é parecer jurídico. Cobre as informações do
> [LGPD art. 9º](../fontes/lei-13709.md#art-9) a partir do que o CRM faz em 2026-10-18; o
> [registro de operações](registro-de-operacoes.md) é a fonte técnica. Depois de publicado, grave a URL em
> `Tenant.avisoPrivacidadeUrl` (Configurações → LGPD) para o rodapé das mensagens apontar para ele.

Os campos `{{...}}` vêm da configuração LGPD do tenant ou dependem de decisão da controladora.

---

## Quem cuida dos seus dados

**{{controladorNome}}** é a controladora dos seus dados pessoais, ou seja, quem decide como eles são usados.
Encarregado pela proteção de dados: **{{encarregadoNome}}**, contato **{{encarregadoContato}}**.

## Quais dados usamos e por quê

| Dados | Para quê | Base legal |
|-------|----------|------------|
| Nome, CPF, telefone, cidade e empresa conveniada | Identificar você e manter seu cadastro de cliente | {{execução de contrato}} |
| Limite, saldo, uso do cartão e compras | Mostrar como você usa o cartão e enviar avisos e ofertas ligados a esse uso | {{execução de contrato / legítimo interesse}} |
| Data de nascimento | Enviar mensagem de aniversário | {{legítimo interesse}} |
| Renda | Apenas estatísticas internas agregadas; não é usada para escolher quem recebe mensagens | {{legítimo interesse}} |
| Mensagens que você nos envia por WhatsApp | Responder ao seu atendimento | {{execução de contrato}} |

Recebemos esses dados {{da sua contratação do cartão / da empresa conveniada}}.

**Como escolhemos quem recebe cada mensagem** ([art. 20](../fontes/lei-13709.md#art-20)): usamos regras simples sobre o
uso do cartão, como saldo disponível, tempo sem uso, renovação de limite, faixa de uso, cidade e aniversário. Nenhuma
decisão sobre crédito ou sobre o seu contrato é tomada de forma automatizada pelo nosso sistema de mensagens.

## Com quem compartilhamos

Com fornecedores de tecnologia que atuam em nosso nome: hospedagem e banco de dados, envio de WhatsApp e SMS, ligações
com assistente virtual e planilhas. Alguns ficam fora do Brasil. {{Inserir a versão pública de
[suboperadores.md](suboperadores.md).}} Não vendemos seus dados.

## Por quanto tempo guardamos

Enquanto você for nosso cliente. Depois de {{retentionDays}} dias sem uso do cartão, ou {{retentionDaysAfterClosure}} dias
após o encerramento da conta, seus dados são anonimizados. Mensagens de atendimento ficam guardadas por
{{inboxRetentionDays}} dias, e arquivos de mídia por {{mediaRetentionDays}} dias. Guardamos por mais tempo apenas o que
a lei exigir ({{retentionBasis}}).

## Seus direitos

Você pode pedir, a qualquer momento ([art. 18](../fontes/lei-13709.md#art-18)): confirmação de que tratamos seus dados,
acesso, correção, anonimização, bloqueio ou eliminação de dados desnecessários, portabilidade, informação sobre
compartilhamento e oposição ao tratamento, nos termos da lei. A confirmação e o acesso completos são fornecidos em
até 15 dias ([art. 19, II](../fontes/lei-13709.md#art-19)).

**Para não receber mais mensagens:** responda **{{palavra de opt-out, ex.: SAIR}}** a qualquer mensagem nossa, ou fale com
o encarregado. O bloqueio vale para todos os canais e não é desfeito por atualizações do cadastro.

Se não ficar satisfeito, você pode reclamar à Autoridade Nacional de Proteção de Dados (ANPD).

## Atualizações

Versão de {{data}}. Mudanças relevantes serão informadas {{como}}.

# Procedimento de resposta a incidentes de segurança com dados pessoais

> **RASCUNHO — requer revisão jurídica.** Rascunho técnico do operador; a controladora aprova, decide e comunica. Não é
> parecer jurídico. Achado 05-04 da [auditoria de 2026-10-18](../auditoria/2026-10-18/relatorio.md).

Base: [LGPD art. 48](../fontes/lei-13709.md#art-48) e a [Res. CD/ANPD 15/2024](../fontes/anpd-res-15-2024-incidentes.md).

## Papéis

| Papel | Quem | Responsabilidade |
|-------|------|------------------|
| Controladora | {{controladorNome}} | Avalia o risco, decide e comunica à ANPD e aos titulares; mantém o registro de incidentes |
| Encarregado | {{encarregadoNome}} | Coordena a resposta e é o contato com a ANPD e os titulares |
| Operadores | Quem desenvolve/hospeda o CRM; quem opera os disparos | Detectam, contêm e avisam a controladora em até **{{24 horas}}** da ciência |

## Prazos

- **Comunicação à ANPD:** 3 dias úteis contados da ciência de que o incidente afetou dados pessoais
  ([Res. 15/2024, Anexo, art. 6º](../fontes/anpd-res-15-2024-incidentes.md#anexo-art-6)), quando puder acarretar risco ou
  dano relevante ([art. 5º](../fontes/anpd-res-15-2024-incidentes.md#anexo-art-5)).
- **Comunicação aos titulares:** no mesmo prazo, em linguagem simples
  ([Anexo, art. 9º](../fontes/anpd-res-15-2024-incidentes.md#anexo-art-9)).
- **Registro do incidente:** todo incidente, comunicado ou não, fica registrado por **5 anos**
  ([Anexo, art. 10](../fontes/anpd-res-15-2024-incidentes.md#anexo-art-10)).

## Passo a passo

1. **Detectar e avisar.** Quem perceber avisa o encarregado e a controladora. Fontes de alerta no CRM: erros e acessos
   anormais nos logs da Vercel, notificações de login bloqueado, divergência na cadeia de hash da trilha de auditoria
   (`services/auditIntegrity.ts`), aviso de um fornecedor.
2. **Conter.** Conforme o caso:
   - credencial vazada: girar o segredo (`JWT_SECRET`, `CRON_SECRET`, chave mestra de cifragem, tokens de canal, chave do
     Supabase) e publicar de novo (variável nova na Vercel só vale após novo deploy);
   - usuário comprometido: desativar o usuário (bloqueia todas as rotas na hora) e trocar senha e 2FA;
   - integração abusada: desativar o canal ou a conta WhatsApp no CRM.
3. **Levantar o escopo** sem copiar dados pessoais para fora do sistema:
   - `AuditLog` por período e por usuário: quem acessou, exportou ou alterou o quê;
   - exports de clientes e de campanhas no período;
   - verificação da integridade da trilha de auditoria;
   - logs da Vercel (o plano Hobby guarda pouco tempo: salve o que for preciso logo no início).
4. **Avaliar o risco** com os critérios do [Anexo, art. 5º](../fontes/anpd-res-15-2024-incidentes.md#anexo-art-5):
   tipo de dado (financeiro, CPF, conversas), volume, se havia proteção (CPF só em hash, credenciais cifradas), e se
   atinge titulares vulneráveis.
5. **Decidir e comunicar.** A controladora decide se comunica; se sim, pelo formulário da ANPD e aos titulares afetados,
   com o conteúdo mínimo do [Anexo, art. 6º](../fontes/anpd-res-15-2024-incidentes.md#anexo-art-6) e do
   [art. 9º](../fontes/anpd-res-15-2024-incidentes.md#anexo-art-9).
6. **Registrar** na tabela abaixo, mesmo se a decisão for não comunicar.
7. **Corrigir a causa** e revisar este procedimento.

## Registro de incidentes

Campos conforme o [Anexo, art. 10](../fontes/anpd-res-15-2024-incidentes.md#anexo-art-10). Sem dado pessoal real aqui.

| # | Data da ciência | Descrição | Dados e titulares afetados (quantidade, categoria) | Avaliação de risco | Comunicado? (ANPD / titulares) | Medidas adotadas |
|---|-----------------|-----------|---------------------------------------------------|--------------------|-------------------------------|------------------|
| 1 | 2026-10 | Importação de compras no formato de cartões alterou dados financeiros de clientes | {{n}} clientes; dados do cartão | {{a avaliar: integridade, sem acesso de terceiro?}} | {{}} | {{reversão via desfazer importação?}} |
| 2 | 2026-08/09 | Chave de serviço do Supabase esquecida na configuração de produção (auditoria de segurança) | Potencialmente toda a base | {{a avaliar: houve uso indevido?}} | {{}} | {{chave girada em ...}} |
| 3 | 2026-08/09 | Deploy de Preview público apontado pela auditoria de segurança | Sem variáveis de banco segundo o verificador | {{provável não comunicável}} | {{}} | {{proteção de Preview ativada?}} |

Os itens 1 a 3 vêm da [auditoria de 2026-10-18](../auditoria/2026-10-18/fora-do-codigo.md) e precisam de avaliação da
controladora.

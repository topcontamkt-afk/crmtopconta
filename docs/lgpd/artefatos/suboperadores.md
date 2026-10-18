# Inventário de suboperadores e transferência internacional

> **RASCUNHO — requer revisão jurídica.** Insumo técnico preparado pelo operador para a controladora. Não é parecer
> jurídico. País, entidade contratante e mecanismo de transferência precisam ser confirmados no contrato/DPA de cada
> provedor. Achados 06-03 e 06-04 da [auditoria de 2026-10-18](../auditoria/2026-10-18/relatorio.md).

Levantado do código em `claude/lgpd-adequacao` (2026-10-18), a partir dos hosts chamados pelo backend e pelo frontend.
Quando um provedor novo entrar no código, atualize esta tabela no mesmo PR (a skill `/lgpd-check` cobra isso na
dimensão 06).

## Para que serve

- O controlador responde pela cadeia de tratamento e precisa saber para onde os dados vão
  ([LGPD art. 39](../fontes/lei-13709.md#art-39), [art. 42](../fontes/lei-13709.md#art-42)).
- Transferência para fora do Brasil só ocorre nas hipóteses do [art. 33](../fontes/lei-13709.md#art-33). Com
  cláusulas-padrão, o controlador publica em linguagem simples o país, a finalidade e os agentes
  ([Res. 19/2024, Anexo I, art. 17](../fontes/anpd-res-19-2024-transf-intl.md#anexo-i-art-17) e
  [art. 32](../fontes/anpd-res-19-2024-transf-intl.md#anexo-i-art-32)). Para destino na União Europeia, ver a
  decisão de adequação da [Res. 32/2026](../fontes/anpd-res-32-2026-adequacao-ue.md).

## Provedores que recebem dados de clientes (titulares)

| Provedor | Onde no código | Dados enviados | Finalidade | Quando é usado | País provável* | Mecanismo art. 33 |
|----------|----------------|----------------|------------|----------------|----------------|-------------------|
| **Supabase** (Postgres) | `DATABASE_URL`, Prisma | Toda a base do CRM: cadastro, dados do cartão, compras, conversas, mídias, trilha de auditoria | Armazenamento | Sempre | A confirmar no painel (região do projeto) | A definir |
| **Vercel** (funções e site) | `backend/vercel.json`, `frontend/vercel.json` | Tudo que passa pela API em trânsito; logs de runtime (sem PII por padrão após o Lote 5) | Hospedagem e execução | Sempre | A confirmar (`vercel.json` não fixa `regions`; padrão da plataforma é EUA) | A definir |
| **Google** (Sheets API) | `services/googleSheets.ts`, `services/biExport.ts` | Leitura: planilha da controladora com cadastro e dados do cartão. Escrita: só agregados (KPIs e campanhas), sem dado pessoal | Importação da base; BI | Quando o tenant conecta uma planilha | EUA / global | A definir |
| **Meta** (WhatsApp Cloud API) | `services/channels/whatsapp.ts`, `whatsappSend.ts`, `whatsappTemplates.ts`, `whatsappMedia.ts`, `whatsappCalling.ts` | Telefone, variáveis do template (nome, saldo etc.), texto e mídia; recebe as respostas do titular | Campanhas, atendimento e ligações via WhatsApp | Canal WhatsApp oficial configurado | EUA | A definir |
| **Z-API** (API não oficial de WhatsApp) | `services/zapi.ts`, `services/zapiMedia.ts` | Telefone, texto e mídia; recebe as respostas do titular | Mesmo uso do WhatsApp, por sessão de aparelho | Conta WhatsApp do tipo `zapi:` | Brasil (a confirmar) | Se no Brasil, só operador (art. 39) |
| **Twilio** (SMS e voz) | `services/channels/sms.ts`, `services/voice.ts` | SMS: telefone e texto. Voz: telefone e áudio da ligação | Campanhas SMS; ligações do agente de voz | Canal SMS Twilio ou ligação de voz | EUA | A definir |
| **Zenvia** (SMS) | `services/channels/sms.ts` | Telefone e texto | Campanhas SMS (provedor alternativo) | Canal SMS Zenvia | Brasil (a confirmar) | Se no Brasil, só operador (art. 39) |
| **xAI** (agente de voz) | `api/voice-bridge.ts`, `services/voiceBridge.ts` | Nome, cidade e saldo disponível (nas instruções do agente) e o áudio da conversa | Ligação com assistente virtual | Ligação de voz disparada no CRM | EUA | A definir |

\* "País provável" é a sede ou região padrão do provedor, **não** uma confirmação. Ver a seção de checagens.

## Provedores que recebem só dados de usuários internos

| Provedor | Onde | Dados | Finalidade |
|----------|------|-------|------------|
| **Vercel Speed Insights** | `frontend/src/main.tsx` | Métricas de desempenho do navegador de quem usa o CRM (URL da página, tempos de carga) | Medir desempenho do site |

## Checagens pendentes (operador)

- [ ] Região do projeto Supabase e da Function Region na Vercel (item 06.2 da auditoria).
- [ ] Entidade contratante e DPA de cada provedor, inclusive se a conta está em nome da controladora ou do operador.
- [ ] Z-API: confirmar se está ativa em produção. Por ser API não oficial, avaliar com a controladora o risco
  contratual com a Meta e a segurança da sessão do aparelho ([art. 46](../fontes/lei-13709.md#art-46)).
- [ ] xAI: confirmar política de retenção e de uso para treino do áudio e da transcrição. Lembrar que
  `VOICE_LOG_TRANSCRIPT=1` grava a transcrição nos logs da Vercel; manter desligado em produção.

## Versão pública (rascunho para o aviso de privacidade)

> Para prestar o serviço, compartilhamos dados com fornecedores de tecnologia que atuam em nosso nome: hospedagem e banco
> de dados ({{região Vercel}}, {{região Supabase}}), envio de mensagens por WhatsApp (Meta, EUA), SMS (Twilio, EUA;
> Zenvia, Brasil), ligações com assistente virtual (Twilio e xAI, EUA) e planilhas (Google, EUA). Quando os dados saem do
> Brasil, a transferência se apoia em {{mecanismo do art. 33}}.

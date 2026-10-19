# 01 · Finalidade, adequação e necessidade (minimização)

Dispositivos centrais: [art. 6º, I–III](../../../../docs/lgpd/fontes/lei-13709.md#art-6) (finalidade,
adequação, necessidade), [art. 5º, II](../../../../docs/lgpd/fontes/lei-13709.md#art-5) (dado sensível),
[art. 11](../../../../docs/lgpd/fontes/lei-13709.md#art-11).

Pergunta-guia: **cada dado pessoal guardado tem uso real no produto e cabe na finalidade declarada
(CRM de relacionamento e campanhas da controladora)?** Um campo coletado "porque veio na planilha" e
nunca lido é achado.

## Checklist

| # | Pergunta verificável | Onde olhar |
|---|----------------------|------------|
| 01.1 | Para cada campo pessoal de `Client`, existe ao menos um **leitor** (rota, serviço, tela, segmento, template) além da importação? Liste campo → leitor. Campos sem leitor são candidatos a corte. Atenção a `dataNascimento`, `sexo`, `remuneracaoBruta`, `remuneracaoLiquida`, `bonus`, `saldoLiquidoSaque`, `lotacao`, `vinculoEmpregaticio`, `razaoSocial`, `email`, `encerramento`/`motivo`. | `backend/prisma/schema.prisma` (model `Client`), `grep -rn "<campo>" backend/src frontend/src` |
| 01.2 | A importação grava **colunas que o mapeamento não precisa**? (ex.: guarda a linha bruta inteira, ou `ImportChange.before` copia todos os campos) | `backend/src/services/importService.ts`, `cardAccountImport.ts`, `purchaseImport.ts`, model `ImportChange` |
| 01.3 | Algum campo é **dado sensível** (art. 5º, II: origem racial, saúde, religião, biometria, vida sexual, filiação sindical/política)? `sexo` sozinho não é sensível, mas confira tags livres, motivo de encerramento, texto de mensagens/inbox e `lotacao` (pode revelar órgão de saúde, sindicato). | `Client.tags`, `motivoEncerramento`, `WaMessage.body`, `Notification.message` |
| 01.4 | Segmentos, automações e o dashboard usam dados de renda ou nascimento para **finalidade compatível** com o que o titular espera (art. 6º, I–II)? Ex.: lista de aniversariantes para marketing; segmentação por remuneração. Registre o uso; a compatibilidade é decisão da controladora (`decisao_negocio`). | `backend/src/routes/dashboard.ts` (engajamento/aniversariantes), `services/segments.ts`, `services/rendaPerfil.ts`, `services/opportunities.ts`, `frontend/src/pages/PerfisRenda.tsx` |
| 01.5 | O escopo OAuth do Google Sheets é o mínimo necessário (leitura vs. escrita)? Escrita só se `biExport` exigir, e então limitada. | `backend/src/services/googleSheets.ts`, `services/biExport.ts` |
| 01.6 | O payload enviado a terceiros (Meta, Twilio, Zenvia) contém só o necessário para a mensagem? Variáveis de template expõem renda ou limite sem necessidade? | `backend/src/services/templateVariables.ts`, `services/channels/*.ts` |
| 01.7 | Respostas da API devolvem a linha inteira (`select` ausente) quando a tela usa poucos campos? Isso amplia exposição sem finalidade. | `backend/src/routes/clients.ts` (`GET /`, `GET /:id`), `routes/dashboard.ts` |
| 01.8 | `CampaignRecipient` (lista manual) guarda campos além de nome, telefone, hash de CPF e limite? O limite da planilha fica guardado depois do envio sem uso? | model `CampaignRecipient`, `backend/src/services/manualCampaign.ts` |

## Não é achado desta dimensão

Segurança do armazenamento (dimensão 05), retenção e prazo (04), vazamento em logs (07). Aqui é só
"precisa ter esse dado, e para esta finalidade?".

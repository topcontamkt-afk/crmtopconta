# 06 · Operadores, suboperadores e transferência internacional

Dispositivos centrais: [art. 5º, VII e X](../../../../docs/lgpd/fontes/lei-13709.md#art-5) (operador,
tratamento), [art. 39](../../../../docs/lgpd/fontes/lei-13709.md#art-39) (operador segue instruções do
controlador), [art. 42](../../../../docs/lgpd/fontes/lei-13709.md#art-42) (responsabilidade solidária do
operador que descumpre), [arts. 33](../../../../docs/lgpd/fontes/lei-13709.md#art-33)–[36](../../../../docs/lgpd/fontes/lei-13709.md#art-36)
(transferência internacional), [Res. 19/2024](../../../../docs/lgpd/fontes/anpd-res-19-2024-transf-intl.md):
mecanismos ([art. 2º](../../../../docs/lgpd/fontes/anpd-res-19-2024-transf-intl.md#art-2), cláusulas-padrão
obrigatórias quando a base é contratual) e transparência na página da controladora
([Anexo I, art. 17, §2º](../../../../docs/lgpd/fontes/anpd-res-19-2024-transf-intl.md#anexo-i-art-17),
[Anexo I, art. 32](../../../../docs/lgpd/fontes/anpd-res-19-2024-transf-intl.md#anexo-i-art-32)),
[Res. 32/2026](../../../../docs/lgpd/fontes/anpd-res-32-2026-adequacao-ue.md) (UE adequada: transferência
para a UE dispensa cláusulas).

Pergunta-guia: **para onde vai cada dado pessoal, fisicamente e juridicamente, e o código permite à
controladora saber e controlar isso?**

Contratos (DPA, cláusulas-padrão) são `fora_do_codigo`: liste quais faltam, mas não os escreva.

## Checklist

| # | Pergunta verificável | Onde olhar |
|---|----------------------|------------|
| 06.1 | Inventário de **todo destino externo** de dado pessoal: hosts chamados por `fetch`/`axios`/SDK no backend e scripts de terceiros no frontend. Para cada: dado enviado, finalidade, país provável. Esperado: Meta Graph (WhatsApp), Twilio, Zenvia, Google Sheets/Drive, Vercel (hosting, Speed Insights), Supabase. Ache os que faltam nessa lista. | `grep -rn "https://\|fetch(\|axios" backend/src frontend/src`, `frontend/src/main.tsx`, `frontend/index.html`, `package.json` de ambos |
| 06.2 | **Região** do Supabase e das funções Vercel: MCP só leitura (Vercel `get_project` mostra a região das functions; Supabase: região do projeto, se algum tool de metadados expuser). Brasil (`gru1`/`sa-east-1`), UE (adequada pela Res. 32/2026) ou EUA (exige mecanismo do art. 33). Sem dado: `nao_verificavel`. | `backend/vercel.json` (`regions`), `docs/security-audit/infra-snapshot.md`, MCP |
| 06.3 | Vercel Speed Insights e analytics no frontend enviam URL com **dado pessoal** (ex.: `/clients/:id` com id real, query string com telefone ou nome)? | `frontend/src/main.tsx`, `frontend/src/App.tsx` (rotas), `grep -rn "navigate(\|useSearchParams" frontend/src` |
| 06.4 | O sistema permite à controladora **escolher ou desligar** provedores por tenant (ex.: SMS via Twilio vs. Zenvia, failover por `ChannelConfig.priority`)? O failover automático manda dado a um provedor que a controladora não autorizou? | `services/channels/*`, model `ChannelConfig` |
| 06.5 | Planilha Google: o service account do **operador** acessa planilhas da controladora. A planilha de BI (`biExport`) recebe só agregados? Confirme que não vai dado pessoal. | `services/googleSheets.ts`, `services/biExport.ts` |
| 06.6 | Instruções do controlador (art. 39): ações de alto impacto feitas pelo operador (purge, export em massa, alteração de retenção, disparo para lista externa) ficam registradas **com autor** e podem ser restritas por role do tenant? | `middleware/audit.ts`, `routes/clients.ts`, `routes/tenant.ts`, `routes/campaigns.ts` |
| 06.7 | Multi-controlador: credenciais e configuração de provedores são **por tenant**, ou há credencial global (env var) usada por todos os tenants? Credencial global mistura controladores no mesmo contrato de provedor. | `services/channels/*`, `services/googleSheets.ts`, `.env.example`, `backend/src/config*` |
| 06.8 | Existe, no repo ou na tela, a **lista de suboperadores** que a controladora possa publicar (Res. 19, Anexo I, art. 32, parágrafo único: documento em linguagem simples sobre a transferência)? | `docs/`, `frontend/src/pages/Settings.tsx` |

# Roteiro: variáveis, produção e teste de disparo (Cloudflare)

Checklist para retomar a migração. Como a infraestrutura funciona está em `cloudflare-ambientes.md`. Comandos rodam em
`backend/`, depois de `set -a; . ./.dev.cloudflare; set +a` (token da conta, fora do git). Estado em 19/10/2026:
homologação no ar no plano grátis, produção não criada.

## 1. Onde fica cada configuração

Três lugares diferentes:

- **`vars` no `wrangler.jsonc`**: valor visível, vai no git, muda com deploy.
- **Segredo do Worker**: `npx wrangler secret put NOME --env <amb>`. Vale na hora, sem deploy, e nunca vai para o git.
- **Tela do CRM**: gravado no banco, cifrado com `CREDENTIALS_ENCRYPTION_KEY`, uma configuração por conta (tenant).

### Variáveis e segredos

| Nome | Tipo | Para quê | hml | Produção |
|---|---|---|---|---|
| `APP_ENV` | var | nome do ambiente (health) | `hml` | `prod` |
| `ALLOWED_ORIGINS` | var | CORS: origem da SPA | URL workers.dev | domínio final |
| `PUBLIC_BACKEND_URL` | var | URLs de webhook, assinatura do Twilio, link rastreado | URL workers.dev | domínio final |
| `MESSAGING_MODE` | var | `mock` = sem canal real, o envio é só simulado | `mock` | **não definir** |
| `LINK_BASE_URL` | var | domínio dentro do botão "Visitar site" rastreado. **Vai no template aprovado pela Meta: mudar exige nova versão do template** | — | domínio final, antes de enviar templates |
| `LINK_FALLBACK_URL` | var | destino de link rastreado inválido (https) | — | site da TopConta |
| `PLATFORM_DEFAULT_TENANT_ID` | var | única conta que pode usar credenciais de canal do ambiente | — | só se usar credencial do ambiente |
| `JWT_SECRET` | segredo | assina o login | ✅ | gerar novo |
| `CREDENTIALS_ENCRYPTION_KEY` | segredo | cifra as credenciais gravadas pela tela | ✅ | gerar nova. **Perder = perder todas as credenciais gravadas** |
| `CRON_SECRET` | segredo | protege `/api/cron/*` | ✅ | gerar novo |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | segredo | ler a planilha e exportar o BI | ❌ falta | a mesma Service Account |
| `WHATSAPP_*`, `TWILIO_*` | segredo | reserva: credencial de canal do ambiente | — | dispensável: use a tela (abaixo) |
| `XAI_API_KEY`, `XAI_*`, `VOICE_*`, `TWILIO_VOICE_NUMBER` | segredo/var | ligação com IA (fase 1) | — | ver "Lacunas": a ponte de voz não roda no Worker |

Para gerar os três segredos, siga o modelo da hml. Crie o arquivo `backend/.dev.vars.<amb>` (fora do git, `chmod 600`) e
suba com `npx wrangler secret bulk --env <amb>`. Os valores nunca vão para o chat nem para commit.

### Pela tela do CRM (por conta)

- **Integrações → WhatsApp (Meta Cloud API)**: Phone Number ID, WABA ID, Access Token, App Secret e App ID (opcional).
  A tela mostra o token de verificação do webhook.
- **Configurações → WhatsApp**: Z-API e qual conexão envia.
- **Integrações → canais SMS (Twilio)**, com a URL de webhook por canal.
- **Integrações → Google Sheets**: ID da planilha, range, mapeamento e cron.
- **Configurações → LGPD**: base legal de marketing. **Sem ela, campanha de marketing não sai.** Também controlador,
  encarregado, rodapé e prazos.
- **Ciclos** (`/ciclos`), custos da mensagem (`/campaigns/custos`), usuários e áreas.

## 2. Subir a produção (cada passo precisa de OK do Filipe)

1. **Plano**: ver "Quando passar ao Workers Paid" em `cloudflare-ambientes.md`. No grátis a produção não tem crons,
   porque o limite é de 5 triggers por conta e a hml usa 3.
2. **Recursos**:
   - `npx wrangler d1 create crmtopconta-prod`
   - `npx wrangler r2 bucket create crmtopconta-prod-media`
   - `npx wrangler queues create crmtopconta-prod-sync`
3. **`wrangler.jsonc`**: copiar o bloco `env.hml` para `env.prod`. Trocar os nomes e o `database_id`, tirar
   `MESSAGING_MODE` e decidir `placement` e `routes` (domínio). O teste `cronTriggers.test.ts` confere os triggers do
   novo ambiente.
4. **Banco**: `npx wrangler d1 migrations apply crmtopconta-prod --env prod --remote`.
5. **Segredos**: os três obrigatórios mais `GOOGLE_SERVICE_ACCOUNT_JSON` (seção 1).
6. **Primeira conta e admin**: falta um script. O seed cria dados de demonstração e não serve para a produção (ver
   "Lacunas").
7. **Deploy**: `npm run cf:build-front && npx wrangler deploy --env prod`. Conferir:
   - `/api/health` com `banco: ok` e `r2: true`;
   - login;
   - Configurações → LGPD preenchida.
8. **Domínio**: rota/custom domain no `wrangler.jsonc` e DNS (só com OK). Depois, `ALLOWED_ORIGINS`,
   `PUBLIC_BACKEND_URL` e `LINK_BASE_URL` com o domínio final.
9. **Dados**: a produção nasce vazia, sem migração do Supabase. Importar pela tela de Importações, nesta ordem:
   - Cartões e contas;
   - Compras;
   - planilha Google.
10. **Webhooks**: só na virada, ver a seção 3.

## 3. Testar disparos

**Cuidado 1: canal conectado pela tela envia de verdade, em qualquer ambiente.** `MESSAGING_MODE=mock` só vale quando a
conta não tem canal conectado (`resolveProviders` em `services/campaignQueue.ts`). Antes de conectar a Meta ou a Z-API na
hml, deixe na base só clientes de teste com números seus. Use "Limpar base" e importe uma planilha pequena.

**Cuidado 2: o app da Meta tem UMA URL de webhook.** Hoje ela aponta para a Vercel (produção atual). Trocá-la para a hml
faz a produção parar de receber:
- respostas (Inbox);
- status de entrega;
- PARAR/SAIR;
- aprovação de templates.

Para testar na hml sem afetar a produção, use um app da Meta separado (com número de teste) ou teste só o envio, sem
webhook. A troca definitiva da URL é a virada da produção.

Roteiro:

1. **Simulado (hml, sem canal)**: criar campanha pelo assistente (`/campaigns/new`) para alguns clientes de teste,
   então "Disparar lote". Esperado:
   - `MessageEvent` como enviado pelo `mock`;
   - relatório da campanha abrindo;
   - opt-out e bloqueio respeitados (cliente com opt-out não entra).
2. **Cron do disparo**: `curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/dispatch`. No grátis, o
   trigger roda às 09:00 UTC (06:00 de Brasília).
3. **Real, só envio** (app da Meta de teste, ou o oficial sem mexer no webhook):
   - conectar em Integrações;
   - "Testar conexão";
   - "Sincronizar" templates;
   - mapear as variáveis do template importado;
   - campanha para 1 a 3 números seus.

   Conferir que chegou com imagem, botões e link rastreado (clicar e ver o clique no relatório). Se `LINK_BASE_URL`
   ainda for o workers.dev, o template com link precisa de nova versão quando o domínio mudar.
4. **Webhook (na virada)**: na Meta, URL `https://<domínio>/api/integrations/webhooks/whatsapp` e o token de verificação
   da tela. Assinar `messages` e os campos de template. Conferir:
   - resposta chegando na Inbox;
   - resposta automática;
   - "PARAR" virando opt-out.

   Na Z-API: "Configurar webhooks automaticamente" (Configurações → WhatsApp). No Twilio (SMS): a URL por canal mostrada
   em Integrações.
5. **Volume**: no grátis cada "Disparar lote" é uma invocação com 10 ms de CPU nominal. Testar um lote de 25 (o tamanho
   que a tela usa) e ver se há erro de CPU nas métricas do Worker antes de uma campanha grande.

## Lacunas conhecidas (não resolvidas na migração)

- **Ponte de voz (xAI + Twilio)**: `api/voice-bridge.ts` era uma função WebSocket da Vercel e não está ligada no Worker.
  As rotas `/api/voice/*` existem, mas a ligação não conecta ao agente. Precisa ser portada (Durable Object ou WebSocket
  no próprio Worker) antes de usar voz na Cloudflare.
- **Criar a primeira conta da produção**: falta um script sem dados de demonstração (tenant + 1 admin com senha forte).
- **Token da Cloudflare** em `backend/.dev.cloudflare`: foi exposto numa sessão anterior; trocar (roll) antes da produção.

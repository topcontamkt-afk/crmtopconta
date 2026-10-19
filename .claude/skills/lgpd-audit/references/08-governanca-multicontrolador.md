# 08 · Governança, responsabilização e prontidão multi-controlador

Dispositivos centrais: [art. 6º, X](../../../../docs/lgpd/fontes/lei-13709.md#art-6) (responsabilização e
prestação de contas), [art. 37](../../../../docs/lgpd/fontes/lei-13709.md#art-37) (registro das operações,
de controlador **e** operador), [art. 38](../../../../docs/lgpd/fontes/lei-13709.md#art-38) (RIPD),
[art. 41](../../../../docs/lgpd/fontes/lei-13709.md#art-41) (encarregado),
[art. 50](../../../../docs/lgpd/fontes/lei-13709.md#art-50) (boas práticas e governança),
[Res. 18/2024, Anexo, arts. 8º](../../../../docs/lgpd/fontes/anpd-res-18-2024-encarregado.md#anexo-art-8)
e [9º](../../../../docs/lgpd/fontes/anpd-res-18-2024-encarregado.md#anexo-art-9) (divulgar identidade e
contato do encarregado), [Res. 2/2022, Anexo I](../../../../docs/lgpd/fontes/anpd-res-02-2022-pequeno-porte.md)
(pequeno porte: registro simplificado [art. 9º](../../../../docs/lgpd/fontes/anpd-res-02-2022-pequeno-porte.md#anexo-i-art-9),
canal sem encarregado [art. 11](../../../../docs/lgpd/fontes/anpd-res-02-2022-pequeno-porte.md#anexo-i-art-11),
exclusão por alto risco [arts. 3º](../../../../docs/lgpd/fontes/anpd-res-02-2022-pequeno-porte.md#anexo-i-art-3)
e [4º](../../../../docs/lgpd/fontes/anpd-res-02-2022-pequeno-porte.md#anexo-i-art-4)).

Contexto fixo: TopConta é a controladora; o Luan (contratado, opera os disparos) e quem desenvolve e
hospeda são operadores. O produto deve servir **vários controladores** (um por `Tenant`) no futuro.

## Checklist

| # | Pergunta verificável | Onde olhar |
|---|----------------------|------------|
| 08.1 | **Config LGPD por tenant**: o `Tenant` tem (ou deveria ter) base legal declarada por finalidade, nome e contato do encarregado (ou canal do titular), URL do aviso de privacidade, prazo de retenção com justificativa, texto de opt-out. Liste o que existe e o que falta. | `schema.prisma` (`Tenant` ~l.95–131), `routes/tenant.ts`, `frontend/src/pages/Settings.tsx` |
| 08.2 | **Registro das operações** (art. 37): o repo ou o sistema tem inventário de tratamentos (dado, finalidade, base, fonte, compartilhamento, retenção, medidas de segurança)? Ele pode ser **gerado por tenant** a partir da config? | `docs/`, `grep -rni "registro de opera\|ROPA" .` |
| 08.3 | **Trilha de responsabilização**: ações do operador sobre dado pessoal ficam no `AuditLog` com autor? Lacunas conhecidas: leitura de cliente (`GET /clients`, `/:id`), leitura e resposta na inbox, lista de aniversariantes, download de mídia. Avalie quais leituras de dado em **volume** precisam de trilha (art. 37, art. 6º, X); leitura unitária pode ser `baixa`. | `middleware/audit.ts`, `routes/clients.ts`, `routes/inbox.ts`, `routes/dashboard.ts` |
| 08.4 | **Separação de controladores**: um usuário pode pertencer a mais de um tenant? Um ADMIN de um tenant consegue ver ou alterar outro? Jobs cross-tenant (scheduler com `DATABASE_URL_ADMIN`) iteram tenants sem misturar dados? | `middleware/auth.ts`, `services/scheduler.ts`, `routes/cron.ts`, model `User` |
| 08.5 | **Usuário do operador**: o perfil de quem só opera (dispara) pode ser mais restrito que ADMIN (sem export, sem purge, sem mudar retenção)? Roles existentes cobrem isso? | `requireRole(...)` em `backend/src/routes/*.ts` |
| 08.6 | **Encarregado e transparência**: existe, em algum lugar que o titular veja, a identidade e o contato do encarregado (ou canal de pequeno porte)? Hoje o titular só vê a mensagem de WhatsApp/SMS. | `services/whatsappReply.ts`, templates, `Tenant` |
| 08.7 | **RIPD** (art. 38): o tratamento tem traços de alto risco (dados financeiros e de renda em larga escala, perfilamento por uso de cartão, decisão automatizada de segmentação)? Isso também afasta o regime de pequeno porte (Res. 2/2022, Anexo I, arts. 3º e 4º). Registre os critérios encontrados no código como insumo; o RIPD em si é `fora_do_codigo`. | `services/usage.ts`, `services/etapaUso.ts`, `services/rendaPerfil.ts`, `services/opportunities.ts`, `services/campaignPerfil.ts` |
| 08.8 | **Documentação viva**: o `CLAUDE.md` e o llm-wiki (`docs/llm-wiki/wiki/topics/seguranca-e-lgpd.md`) descrevem os controles LGPD de forma fiel ao código atual? Afirmação desatualizada (ex.: "retenção anonimiza tudo") é achado `baixa`. | `CLAUDE.md`, `docs/llm-wiki/wiki/topics/seguranca-e-lgpd.md`, `README.md` |
| 08.9 | **Pendências fora do código** a listar (não são achados de código): contrato controladora↔operador (Luan; quem hospeda), DPAs ou cláusulas com Meta/Twilio/Zenvia/Google/Vercel/Supabase, nomeação de encarregado, RIPD, aviso de privacidade publicado, política de segurança (simplificada se pequeno porte). | n/a |

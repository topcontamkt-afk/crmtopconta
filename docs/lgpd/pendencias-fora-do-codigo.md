# Pendências fora do código

Checklist vivo do que a adequação de código não resolve. A origem e a fundamentação de cada item estão em
[auditoria/2026-10-18/fora-do-codigo.md](auditoria/2026-10-18/fora-do-codigo.md). Aqui fica só o andamento: marque o item e
anote a data e onde o documento final está guardado.

> Contratos e textos públicos são da controladora e passam por revisão jurídica. O operador fornece os insumos técnicos
> de `artefatos/`.

| # | Pendência | Quem age | Insumo pronto | Status |
|---|-----------|----------|---------------|--------|
| 1 | Contrato de operador com quem opera os disparos | Controladora | — | ☐ |
| 2 | Contrato de operador com quem desenvolve e hospeda o CRM | Controladora | — | ☐ |
| 3 | Termo de confidencialidade de quem acessa dados (05-06) | Controladora | — | ☐ |
| 4 | DPA e mecanismo do art. 33 com cada suboperador (06-03) | Controladora | [suboperadores.md](artefatos/suboperadores.md) | ☐ |
| 5 | Nomear o encarregado e publicar o contato; gravar em Configurações → LGPD | Controladora | — | ☐ |
| 6 | Publicar o aviso de privacidade; gravar a URL em Configurações → LGPD | Controladora | [aviso-de-privacidade.md](artefatos/aviso-de-privacidade.md) | ☐ |
| 7 | Publicar o inventário de suboperadores e a transferência internacional | Controladora | [suboperadores.md](artefatos/suboperadores.md) | ☐ |
| 8 | Registro das operações de tratamento (08-05) | Controladora e operador | [registro-de-operacoes.md](artefatos/registro-de-operacoes.md) | ☐ |
| 9 | Avaliar alto risco e elaborar o RIPD (08-06) | Controladora | Insumos em [fora-do-codigo.md, seção 3](auditoria/2026-10-18/fora-do-codigo.md#3-documentos-de-governança) | ☐ |
| 10 | Aprovar a LIA; gravar versão e data em Configurações → LGPD | Controladora | [lia-template.md](artefatos/lia-template.md) | ☐ |
| 11 | Política de segurança da informação | Controladora | Medidas técnicas em [registro-de-operacoes.md](artefatos/registro-de-operacoes.md#medidas-de-segurança-art-46) | ☐ |
| 12 | Aprovar o procedimento de incidentes e avaliar os 3 eventos já registrados (05-04) | Controladora | [procedimento-incidentes.md](artefatos/procedimento-incidentes.md) | ☐ |
| 13 | Confirmar a região da Vercel e do Supabase | Operador | — | ☐ |
| 14 | Confirmar se a Z-API está ativa em produção | Operador | — | ☐ |
| 15 | Confirmar uma execução real do job de retenção | Operador | — | ☐ |
| 16 | Confirmar que o Data API (PostgREST) do Supabase está desligado | Operador | — | ☐ |
| 17 | Fundamento do prazo de retenção e prazo pós-encerramento (decisões 4 e 5 da triagem) | Controladora | — | ☐ |
| 18 | Confirmar que nenhum campo cortado por minimização tem uso, antes do SQL destrutivo (decisão 3) | Controladora | `backend/prisma/sql/2026-10-lgpd-minimizacao-dados.sql` | ☐ |

---
tags: [testes, Jest, TypeScript, qualidade]
created: 2026-09-10
updated: 2026-09-10
sources: [repository-analysis.md]
---

# Testes e qualidade

> A cobertura existente prioriza regras de negócio, segurança e invariantes de dados do backend.

## Áreas cobertas

- Configuração de ambiente e validação.
- Isolamento de tenant.
- Auditoria e integridade da hash-chain.
- Rate limiting.
- Cálculo de uso e limites de faixa.
- Segmentos AND/OR.
- Masking, hashing e normalização de PII.
- Lockout de autenticação.
- Significância estatística de A/B testing.
- Assinaturas de webhook.
- Retenção e anonimização.

## Comandos

```bash
cd backend
npm test
npm run build

cd ../frontend
npm run build
```

## Lacunas

Não há suíte frontend identificada. Também são recomendáveis testes de contrato da API, integração com banco em ambiente controlado, testes de idempotência de webhook, testes de concorrência da fila e testes E2E dos fluxos de autenticação, importação e campanha.

## Relações

- [[wiki/topics/api-rest.md]]
- [[wiki/topics/seguranca-e-lgpd.md]]
- [[wiki/topics/operacao-e-deploy.md]]

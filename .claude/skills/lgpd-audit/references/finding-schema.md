# Contrato de achado LGPD

Vale para `/lgpd-audit` e `/lgpd-check`. Achado fora deste formato é descartado.

## Regras duras

1. **Citação obrigatória e verificável.** Todo achado cita pelo menos um dispositivo como link relativo para
   uma âncora que **existe** em `docs/lgpd/fontes/`. Confira com
   `grep -n 'id="art-7"' docs/lgpd/fontes/lei-13709.md`. Âncora inexistente invalida o achado.
   Formatos: `docs/lgpd/fontes/lei-13709.md#art-46`,
   `docs/lgpd/fontes/anpd-res-15-2024-incidentes.md#anexo-art-6`,
   `docs/lgpd/fontes/anpd-guia-legitimo-interesse.md#p-30`.
2. **Evidência no código, com linha.** `arquivo:linha` relativo à raiz do repo, mais um trecho curto copiado
   do arquivo. "Ausência de X" também precisa de evidência: diga onde procurou (comando `grep` e
   resultado vazio, ou o arquivo onde X deveria estar).
3. **Cenário concreto.** Quem, o quê e quando: "operador exporta CSV de 50 mil clientes com telefone em
   claro; o arquivo sai do controle do sistema sem trilha", não "pode haver risco".
4. **Nunca copie dado pessoal real** para o achado: telefone, nome, CPF, e-mail ou conteúdo de mensagem
   vistos em logs, seeds ou fixtures. Mascare (`+55 11 9****-**21`) ou descreva o tipo do dado.
5. **Sem inventar obrigação.** Se a lei não exige, não é achado. Se for boa prática sem dispositivo
   claro, use severidade `baixa` e cite o princípio do art. 6º que mais se aproxima, explicando isso no
   cenário.
6. **Separe código de decisão.** Quando a correção depende de escolha da controladora (base legal,
   prazo de retenção, quais campos manter), o tipo é `decisao_negocio`: descreva as opções e recomende
   uma. Contrato, nomeação de encarregado ou RIPD como documento têm tipo `fora_do_codigo`.

## Campos

| Campo | Conteúdo |
|-------|----------|
| `id` | `<dimensao>-<nn>`, ex. `04-03` |
| `titulo` | uma linha, afirmativa ("Retenção não anonimiza `WaMessage.body`") |
| `severidade` | `critica` · `alta` · `media` · `baixa` (critérios abaixo) |
| `dispositivos` | lista de links-âncora (regra 1) |
| `evidencias` | lista de `{arquivo, linha, trecho}` (regra 2) |
| `cenario` | regra 3 |
| `papel` | `controladora` · `operador` · `ambos` (quem descumpre) |
| `correcao` | o que mudar, em quais arquivos, reusando o que já existe |
| `tipo` | `codigo` · `decisao_negocio` · `fora_do_codigo` |
| `multi_tenant` | o que da correção vira configuração por `Tenant`, ou `n/a` |

## Severidade

- **critica**: dado pessoal exposto a quem não deveria ver, hoje, sem ação de terceiro (endpoint sem auth,
  vazamento entre tenants, PII em log público), ou tratamento sem nenhuma base legal possível.
- **alta**: um direito do titular não pode ser atendido (eliminação, acesso, oposição); retenção
  indefinida de dado pessoal; envio a quem fez opt-out; não há como cumprir o prazo de incidente.
- **media**: obrigação atendida parcialmente (anonimização que esquece campos, log com PII só no
  servidor, export sem trilha, minimização questionável).
- **baixa**: transparência, documentação, endurecimento e boas práticas (art. 6º, X; art. 50).

## Saída por dimensão (`/lgpd-audit`)

Além de `achados`, cada agente devolve `cobertura`: uma entrada por item do checklist da dimensão com
`status` `ok` (verificado, conforme), `achado` (gerou achado; cite o id), `nao_verificavel` (precisa de
dado que o escopo proíbe ler; diga qual) ou `nao_aplicavel`. Item do checklist sem entrada em
`cobertura` é falha da varredura.

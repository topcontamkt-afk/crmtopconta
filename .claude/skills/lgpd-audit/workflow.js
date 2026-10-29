export const meta = {
  name: 'lgpd-audit',
  description: 'Varredura LGPD do CRM TopConta: 8 dimensões, verificação adversarial e relatório em docs/lgpd/auditoria',
  whenToUse: 'Invocado pela skill /lgpd-audit. args: { data: "AAAA-MM-DD", dimensoes?: ["01".."08"], saida?: "docs/lgpd/auditoria/<data>" }',
  phases: [
    { title: 'Varredura', detail: 'um agente por dimensão do checklist' },
    { title: 'Verificação', detail: 'um verificador adversarial por dimensão' },
    { title: 'Consolidação', detail: 'deduplica e escreve o relatório' },
  ],
}

const REF = '.claude/skills/lgpd-audit/references'
const DIMENSOES = [
  { id: '01', nome: 'Finalidade e minimização', arquivo: '01-finalidade-minimizacao.md', mcp: false },
  { id: '02', nome: 'Base legal e consentimento', arquivo: '02-base-legal-consentimento.md', mcp: false },
  { id: '03', nome: 'Direitos do titular', arquivo: '03-direitos-titular.md', mcp: false },
  { id: '04', nome: 'Retenção e eliminação', arquivo: '04-retencao-eliminacao.md', mcp: true },
  { id: '05', nome: 'Segurança e incidentes', arquivo: '05-seguranca-incidentes.md', mcp: true },
  { id: '06', nome: 'Suboperadores e transferência internacional', arquivo: '06-suboperadores-transf-intl.md', mcp: true },
  { id: '07', nome: 'Vazamento de dado pessoal', arquivo: '07-vazamento-pii.md', mcp: true },
  { id: '08', nome: 'Governança e multi-controlador', arquivo: '08-governanca-multicontrolador.md', mcp: false },
]

const a = args || {}
if (!a.data) throw new Error('args.data (AAAA-MM-DD) é obrigatório')
const SAIDA = a.saida || `docs/lgpd/auditoria/${a.data}`
// Rodada incremental: texto anexado à varredura e à consolidação (ex.: intervalo de commits e relatório anterior).
const FOCO = a.foco ? `\n\nFOCO DESTA RODADA (prevalece sobre o escopo geral):\n${a.foco}\n` : ''
const alvo = a.dimensoes && a.dimensoes.length ? DIMENSOES.filter(d => a.dimensoes.includes(d.id)) : DIMENSOES
if (alvo.length < DIMENSOES.length) log(`Rodando só as dimensões ${alvo.map(d => d.id).join(', ')}`)

const EVIDENCIA = {
  type: 'object',
  properties: { arquivo: { type: 'string' }, linha: { type: 'integer' }, trecho: { type: 'string' } },
  required: ['arquivo', 'linha', 'trecho'],
}
const ACHADO = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    titulo: { type: 'string' },
    severidade: { type: 'string', enum: ['critica', 'alta', 'media', 'baixa'] },
    dispositivos: { type: 'array', items: { type: 'string' }, minItems: 1 },
    evidencias: { type: 'array', items: EVIDENCIA, minItems: 1 },
    cenario: { type: 'string' },
    papel: { type: 'string', enum: ['controladora', 'operador', 'ambos'] },
    correcao: { type: 'string' },
    tipo: { type: 'string', enum: ['codigo', 'decisao_negocio', 'fora_do_codigo'] },
    multi_tenant: { type: 'string' },
  },
  required: ['id', 'titulo', 'severidade', 'dispositivos', 'evidencias', 'cenario', 'papel', 'correcao', 'tipo', 'multi_tenant'],
}
const VARREDURA = {
  type: 'object',
  properties: {
    achados: { type: 'array', items: ACHADO },
    cobertura: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          item: { type: 'string' },
          status: { type: 'string', enum: ['ok', 'achado', 'nao_verificavel', 'nao_aplicavel'] },
          nota: { type: 'string' },
        },
        required: ['item', 'status', 'nota'],
      },
    },
  },
  required: ['achados', 'cobertura'],
}
const VEREDITOS = {
  type: 'object',
  properties: {
    vereditos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          veredito: { type: 'string', enum: ['CONFIRMED', 'PLAUSIBLE', 'REFUTED'] },
          severidade_ajustada: { type: 'string', enum: ['critica', 'alta', 'media', 'baixa'] },
          dispositivos_validos: { type: 'boolean' },
          motivo: { type: 'string' },
        },
        required: ['id', 'veredito', 'severidade_ajustada', 'dispositivos_validos', 'motivo'],
      },
    },
  },
  required: ['vereditos'],
}
const RESUMO = {
  type: 'object',
  properties: {
    arquivos: { type: 'array', items: { type: 'string' } },
    contagem: {
      type: 'object',
      properties: {
        critica: { type: 'integer' }, alta: { type: 'integer' }, media: { type: 'integer' }, baixa: { type: 'integer' },
        decisoes_negocio: { type: 'integer' }, fora_do_codigo: { type: 'integer' }, refutados: { type: 'integer' },
      },
      required: ['critica', 'alta', 'media', 'baixa', 'decisoes_negocio', 'fora_do_codigo', 'refutados'],
    },
    destaques: { type: 'array', items: { type: 'string' } },
  },
  required: ['arquivos', 'contagem', 'destaques'],
}

const ESCOPO = `Regras de escopo (inegociáveis):
- Somente leitura. Não edite, crie ou apague arquivos. Não rode git que altere estado. Não rode npm install nem migrations.
- Proibido: execute_sql, apply_migration ou qualquer escrita via MCP; conectar no banco por connection string; ler .env com segredos.
- O "Contexto fixo" do checklist (papéis, controladora, operadores) é fato dado pelo usuário; não o conteste.
- Nunca copie dado pessoal real (telefone, nome, CPF, e-mail, texto de mensagem) para a saída; mascare ou descreva o tipo.`

function promptVarredura(d) {
  const mcp = d.mcp
    ? `\nMCP permitido nesta dimensão, só leitura e só metadados/logs: Vercel (get_project, list_deployments, get_runtime_logs, get_runtime_errors) e Supabase (get_advisors, list_tables, list_extensions, list_migrations). Carregue o schema via ToolSearch antes de usar. Se a ferramenta não estiver disponível ou pedir autenticação, marque o item como nao_verificavel e siga.`
    : '\nEsta dimensão não usa MCP: só código, configs e docs do repositório.'
  return `Você é auditor de conformidade LGPD do CRM TopConta (repositório no diretório atual), responsável pela dimensão ${d.id} · ${d.nome}.

Leia por completo, nesta ordem:
1. docs/lgpd/README.md (papéis, convenções de citação)
2. ${REF}/finding-schema.md (formato, regras duras, severidade)
3. ${REF}/${d.arquivo} (seu checklist)

Depois percorra o checklist item a item contra o código em HEAD. Para cada item:
- Abra e leia os arquivos indicados (não conclua só por grep; os números de linha do checklist são aproximados e o código pode ter mudado). Siga as chamadas até onde o comportamento se decide.
- Abra o dispositivo legal citado em docs/lgpd/fontes/ e confirme que o texto sustenta a exigência. Use só âncoras que existem (grep 'id="..."').
- Registre o resultado em "cobertura" (todo item do checklist precisa de uma entrada) e, quando houver descumprimento, um achado no formato do finding-schema, com id ${d.id}-NN.
Se encontrar algo relevante para esta dimensão que o checklist não previu, inclua também (cobertura com item "extra").
${mcp}${FOCO}

${ESCOPO}

Prefira poucos achados sólidos a muitos especulativos: um verificador adversarial vai tentar refutar cada um.`
}

function promptVerificacao(d, achados) {
  return `Você é verificador ADVERSARIAL de achados LGPD da dimensão ${d.id} · ${d.nome} do CRM TopConta (repositório no diretório atual). Seu trabalho é tentar REFUTAR cada achado abaixo.

Leia antes ${REF}/finding-schema.md (critérios de severidade e regras de citação).

Para cada achado:
1. Evidência: abra cada arquivo:linha. O trecho existe (aproximadamente naquela linha) e faz o que o achado diz? Se não existe ou diz outra coisa, REFUTED.
2. Mitigação ignorada: procure no código o que neutraliza o problema (middleware, filtro em outra camada, job que cobre o caso, validação no frontend e no backend, flag desligada em produção). Se houver mitigação completa, REFUTED; parcial, ajuste a severidade.
3. Dispositivo: abra cada link em docs/lgpd/fontes/ e confira que a âncora existe (grep 'id="..."') e que o texto exige o que o achado afirma. Âncora inexistente: dispositivos_validos=false. Exigência inventada ou forçada: REFUTED.
4. Severidade: reavalie pelos critérios do finding-schema; severidade_ajustada pode subir ou descer.
5. Veredito: CONFIRMED (evidência e exigência conferidas), PLAUSIBLE (código conferido, mas depende de fato fora do repositório, como configuração de produção ou decisão da controladora), REFUTED (não se sustenta). Na dúvida entre CONFIRMED e REFUTED, prefira PLAUSIBLE com motivo explícito.

Devolva exatamente um veredito por id. Motivo curto e concreto (arquivo:linha do que você viu).

${ESCOPO}

Achados:
${JSON.stringify(achados, null, 1)}`
}

phase('Varredura')
const porDimensao = await pipeline(
  alvo,
  d => agent(promptVarredura(d), { label: `varredura:${d.id}`, phase: 'Varredura', schema: VARREDURA }),
  async (scan, d) => {
    if (!scan) return null
    if (!scan.achados.length) {
      log(`${d.id}: nenhum achado; verificação dispensada`)
      return { dimensao: d, cobertura: scan.cobertura, achados: [] }
    }
    const v = await agent(promptVerificacao(d, scan.achados), { label: `verificacao:${d.id}`, phase: 'Verificação', schema: VEREDITOS })
    const porId = new Map((v ? v.vereditos : []).map(x => [x.id, x]))
    const achados = scan.achados.map(f => {
      const vd = porId.get(f.id)
      return vd
        ? { ...f, severidade_original: f.severidade, severidade: vd.severidade_ajustada, veredito: vd.veredito, dispositivos_validos: vd.dispositivos_validos, motivo_verificacao: vd.motivo }
        : { ...f, veredito: 'PLAUSIBLE', dispositivos_validos: false, motivo_verificacao: 'verificador não retornou veredito para este id' }
    })
    log(`${d.id}: ${achados.filter(x => x.veredito !== 'REFUTED').length}/${achados.length} achados sobreviveram`)
    return { dimensao: d, cobertura: scan.cobertura, achados }
  },
)

const falhas = alvo.filter((d, i) => !porDimensao[i])
if (falhas.length) log(`ATENÇÃO: dimensões sem resultado (agente falhou): ${falhas.map(d => d.id).join(', ')}`)
const ok = porDimensao.filter(Boolean)
const sobreviventes = ok.flatMap(r => r.achados.filter(f => f.veredito !== 'REFUTED' && f.dispositivos_validos !== false))
const descartados = ok.flatMap(r => r.achados.filter(f => f.veredito === 'REFUTED' || f.dispositivos_validos === false))
const cobertura = ok.map(r => ({ dimensao: r.dimensao.id, nome: r.dimensao.nome, itens: r.cobertura }))

phase('Consolidação')
const resumo = await agent(`Você consolida a varredura LGPD do CRM TopConta (repositório no diretório atual). Escreva os arquivos abaixo em ${SAIDA}/ (crie o diretório). Não edite nenhum outro arquivo.

Leia antes docs/lgpd/README.md e ${REF}/finding-schema.md.

1. Deduplicação: achados de dimensões diferentes com a mesma causa (mesmo arquivo:linha ou mesma correção) viram um só; mantenha o id de menor dimensão, junte dispositivos e evidências e registre "também: <ids>".
2. ${SAIDA}/achados.json: array com todos os achados sobreviventes, deduplicados, no formato recebido.
3. ${SAIDA}/relatorio.md, em pt-BR:
   - Cabeçalho: data ${a.data}, commit (rode \`git rev-parse --short HEAD\`), dimensões cobertas${falhas.length ? `, e AVISO de que as dimensões ${falhas.map(d => d.id).join(', ')} falharam e não foram cobertas` : ''}.
   - Resumo executivo (até 10 linhas): os riscos que mais importam, em linguagem de negócio.
   - Tabela de contagem por severidade e por tipo.
   - Achados por severidade (critica → baixa). Cada um com título, id, veredito, dispositivos como links relativos a partir de ${SAIDA}/ (ex.: ../../fontes/lei-13709.md#art-46), evidências como \`arquivo:linha\`, cenário, correção e multi_tenant.
   - Seção "Cobertura": tabela por dimensão com contagem de itens ok/achado/nao_verificavel/nao_aplicavel e a lista dos nao_verificavel com o motivo.
   - Seção "Descartados na verificação": id, título e motivo, uma linha cada.
4. ${SAIDA}/decisoes-pendentes.md: só achados tipo decisao_negocio. Para cada um, a pergunta à controladora, as opções, o impacto de cada uma no código e a recomendação.
5. ${SAIDA}/fora-do-codigo.md: achados tipo fora_do_codigo mais as pendências do item 08.9 do checklist, como checklist de ações para a controladora (contratos, encarregado, RIPD, aviso publicado). Diga quem age: controladora ou operador.

Os links para docs/lgpd/fontes/ devem continuar válidos a partir do diretório de saída. Confira cada um com grep antes de escrever.${FOCO}
Não copie dado pessoal real.

Achados sobreviventes (${sobreviventes.length}):
${JSON.stringify(sobreviventes, null, 1)}

Descartados (${descartados.length}):
${JSON.stringify(descartados.map(f => ({ id: f.id, titulo: f.titulo, motivo: f.motivo_verificacao, veredito: f.veredito, dispositivos_validos: f.dispositivos_validos })), null, 1)}

Cobertura:
${JSON.stringify(cobertura, null, 1)}`, { label: 'consolidacao', phase: 'Consolidação', schema: RESUMO })

return { saida: SAIDA, falhas: falhas.map(d => d.id), sobreviventes: sobreviventes.length, descartados: descartados.length, resumo }

import { normalizeHeader } from "./csv";

/**
 * Campos aceitos pela importação (mesmos de backend/src/services/importService.ts —
 * RawSheetRow). `synonyms` cobre variações comuns de nome de coluna em planilhas reais
 * (com/sem acento, com espaço, abreviações) para o auto-mapeamento do upload direto.
 */
export interface ImportFieldDef {
  key: string;
  label: string;
  required: boolean;
  synonyms: string[];
}

export const IMPORT_FIELDS: ImportFieldDef[] = [
  { key: "id_cliente", label: "ID do cliente", required: true, synonyms: ["id_cliente", "id", "idcliente", "codigo", "codigo_cliente", "cod_cliente"] },
  { key: "nome", label: "Nome", required: true, synonyms: ["nome", "nome_cliente", "cliente", "nome_completo"] },
  { key: "telefone", label: "Telefone", required: true, synonyms: ["telefone", "fone", "celular", "whatsapp", "telefone_celular", "numero"] },
  { key: "cpf", label: "CPF", required: true, synonyms: ["cpf", "documento", "cpf_cnpj"] },
  { key: "cidade", label: "Cidade", required: false, synonyms: ["cidade", "municipio"] },
  { key: "data_cadastro", label: "Data de cadastro", required: false, synonyms: ["data_cadastro", "cadastro", "data_de_cadastro"] },
  { key: "data_abertura_conta", label: "Data de abertura da conta", required: false, synonyms: ["data_abertura_conta", "data_abertura", "abertura_conta", "data_de_abertura_da_conta"] },
  { key: "limite_total", label: "Limite total", required: false, synonyms: ["limite_total", "limite", "limite_de_credito"] },
  { key: "valor_utilizado", label: "Valor utilizado", required: false, synonyms: ["valor_utilizado", "utilizado", "valor_usado"] },
  { key: "saldo_disponivel", label: "Saldo disponível", required: false, synonyms: ["saldo_disponivel", "saldo", "saldo_disponivel_"] },
  { key: "valor_antecipado", label: "Valor antecipado", required: false, synonyms: ["valor_antecipado", "antecipado"] },
  { key: "data_ultima_utilizacao", label: "Data da última utilização", required: false, synonyms: ["data_ultima_utilizacao", "ultima_utilizacao", "ultimo_uso", "data_ultimo_uso"] },
  { key: "status_conta", label: "Status da conta", required: false, synonyms: ["status_conta", "status", "status_da_conta", "situacao"] },
  { key: "origem_cliente", label: "Origem do cliente", required: false, synonyms: ["origem_cliente", "origem"] },
  { key: "autorizacao_comunicacao", label: "Autorização de comunicação (LGPD)", required: false, synonyms: ["autorizacao_comunicacao", "autorizacao", "opt_in", "aceite_lgpd", "lgpd"] },
];

/**
 * Formato real de "Cartões e contas" — mesmos campos de
 * backend/src/services/cardAccountImport.ts (CardAccountRow). Cobre as duas planilhas reais
 * confirmadas com o cliente (2026-08-20), que trazem subconjuntos diferentes de colunas:
 *  - "Cartões e contas": STATUS explícito (ATIVOU_CARTAO/PODE_TER_MAS_NAO_ATIVOU/NAO_PODE_TER),
 *    Bloqueado, Encerramento, empresa/cidade conveniada, vínculo empregatício.
 *  - "SaldoCartao" (fonte principal, mais completa): sem STATUS explícito — usa StatusCadastro +
 *    saldo utilizado —, mas traz razão social, cartão, lotação, dados de RH (salário,
 *    nascimento, sexo) e dois flags de bloqueio (CartaoBloqueado/ContaBloqueada).
 * Nenhuma das duas tem coluna de autorização de comunicação — a regra de consentimento fica no
 * backend (aceite no contrato de abertura de conta).
 */
export const CARD_ACCOUNT_FIELDS: ImportFieldDef[] = [
  { key: "documento", label: "CPF/CNPJ", required: true, synonyms: ["cpfcnpjcliente", "cpf_cnpj_cliente", "cpfcnpj", "cpf_cnpj", "cpf", "cnpj", "documento"] },
  { key: "nome", label: "Nome", required: true, synonyms: ["nomecliente", "nome_cliente", "nome", "cliente"] },
  { key: "telefone", label: "Telefone/Celular", required: true, synonyms: ["celular", "telefone", "fone", "whatsapp"] },
  { key: "email", label: "E-mail", required: false, synonyms: ["email", "e_mail", "emailcliente", "email_cliente"] },
  { key: "cidade", label: "Cidade", required: false, synonyms: ["nomecidade", "nome_cidade", "cidade", "municipio"] },
  { key: "razao_social", label: "Razão social (promotora/associação)", required: false, synonyms: ["razaosocial", "razao_social"] },
  { key: "id_cartao", label: "ID do cartão", required: false, synonyms: ["idcartao", "id_cartao"] },
  { key: "lotacao", label: "Lotação (departamento/unidade)", required: false, synonyms: ["lotacao"] },
  { key: "data_cadastro", label: "Data de cadastro", required: false, synonyms: ["dtsoliccadastro", "dt_solic_cadastro", "data_cadastro", "datacadastro"] },
  { key: "data_ativacao", label: "Data de ativação do cartão", required: false, synonyms: ["dtativacaocartao", "dt_ativacao_cartao", "data_ativacao"] },
  { key: "data_validade_cartao", label: "Data de validade do cartão", required: false, synonyms: ["datavalidade", "data_validade"] },
  { key: "data_nascimento", label: "Data de nascimento", required: false, synonyms: ["datanascimento", "data_nascimento"] },
  { key: "sexo", label: "Sexo", required: false, synonyms: ["sexo"] },
  { key: "limite", label: "Limite", required: false, synonyms: ["limite", "limitetotal", "limite_total", "limitedecompras"] },
  { key: "saldo_disponivel", label: "Saldo disponível", required: false, synonyms: ["saldodisponivel", "saldo_disponivel", "saldo"] },
  { key: "valor_utilizado", label: "Saldo/valor utilizado", required: false, synonyms: ["saldoutilizado", "valorutilizado", "valor_utilizado"] },
  { key: "bonus", label: "Bônus", required: false, synonyms: ["bonus"] },
  { key: "saldo_liquido_saque", label: "Saldo líquido para saque", required: false, synonyms: ["saldoliquidosaque", "saldo_liquido_saque"] },
  { key: "remuneracao_bruta", label: "Remuneração bruta", required: false, synonyms: ["remuneracaobruta", "remuneracao_bruta"] },
  { key: "remuneracao_liquida", label: "Remuneração líquida", required: false, synonyms: ["remuneracaoliquida", "remuneracao_liquida"] },
  { key: "status_cartao", label: "STATUS (do cartão)", required: false, synonyms: ["status", "statuscartao", "status_cartao"] },
  { key: "status_cadastro", label: "Status do cadastro (ex.: APROVADO)", required: false, synonyms: ["statuscadastro", "status_cadastro", "statusvalidacaocadastro"] },
  { key: "bloqueado", label: "Bloqueado", required: false, synonyms: ["bloqueado"] },
  { key: "cartao_bloqueado", label: "Cartão bloqueado", required: false, synonyms: ["cartaobloqueado", "cartao_bloqueado"] },
  { key: "conta_bloqueada", label: "Conta bloqueada", required: false, synonyms: ["contabloqueada", "conta_bloqueada"] },
  { key: "encerrado", label: "Encerramento", required: false, synonyms: ["encerramento", "encerrado"] },
  { key: "motivo_encerramento", label: "Motivo (encerramento)", required: false, synonyms: ["motivo"] },
  { key: "obs_encerramento", label: "Observação (encerramento)", required: false, synonyms: ["obsencerramento", "obs_encerramento", "observacaoencerramento"] },
  { key: "empresa_conveniada", label: "Empresa conveniada", required: false, synonyms: ["nomefantasia", "nome_fantasia", "empresaconveniada", "empresa_conveniada"] },
  { key: "cidade_empresa_conveniada", label: "Cidade da empresa conveniada", required: false, synonyms: ["nomecidadeempresaconveniada", "nome_cidade_empresa_conveniada", "cidadeempresaconveniada"] },
  { key: "vinculo_empregaticio", label: "Vínculo empregatício", required: false, synonyms: ["vinculoempregaticio", "vinculo_empregaticio"] },
];

/** Para cada campo, encontra o índice da coluna do CSV cujo cabeçalho normalizado bate com algum sinônimo. */
export function autoMapColumns(headers: string[], fields: ImportFieldDef[] = IMPORT_FIELDS): Record<string, number> {
  const normalized = headers.map(normalizeHeader);
  const mapping: Record<string, number> = {};
  for (const field of fields) {
    const idx = normalized.findIndex((h) => field.synonyms.includes(h));
    if (idx !== -1) mapping[field.key] = idx;
  }
  return mapping;
}

/**
 * Cidade do cliente para filtros do Comércio credenciado. Regra de negócio: o cliente só usa o cartão
 * no comércio da PRÓPRIA cidade, então a cidade do cliente é a cidade da compra.
 *
 * A coluna `cidade` da planilha às vezes traz o nome de uma empresa ("TOP CONTA", "... LTDA", "... PROMOTORA")
 * ou vem vazia: esses casos viram "Sem cidade". No banco a chave fica gravada em `Client.cidadeKey` (calculada por
 * esta mesma função a cada gravação de `cidade`, ver config/derivedColumns.ts): o SQLite não tem regex.
 */
export const SEM_CIDADE = "__SEM_CIDADE__";

const NAO_E_CIDADE = /(\b(ltda|eireli|epp|promotora|servi[cç]os?|cobran[cç]a|associa[cç][aã]o|business)\b|top ?conta|\d)/i;

/** Chave de comparação da cidade (minúscula, sem espaços nas pontas) ou SEM_CIDADE. */
export function cidadeKey(raw: string | null | undefined): string {
  const t = (raw ?? "").trim();
  if (!t || NAO_E_CIDADE.test(t)) return SEM_CIDADE;
  return t.toLowerCase();
}

/**
 * Lista vinda da query (`natal|luziânia|__SEM_CIDADE__`); vazia = sem filtro. As chaves são devolvidas
 * exatamente como estão gravadas (GET /cidades), por isso aqui só se tiram espaços.
 */
export function parseCidades(param: string | undefined): string[] {
  return (param ?? "")
    .split("|")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => (c.toLowerCase() === SEM_CIDADE.toLowerCase() ? SEM_CIDADE : c))
    .slice(0, 50);
}

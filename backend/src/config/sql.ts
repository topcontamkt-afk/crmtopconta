/**
 * Pedaços de SQL do dialeto do SQLite/D1 usados pelo SQL cru (tenantRaw). Datas: o Prisma grava DateTime como
 * texto ISO com fuso ("2026-10-19T03:31:02.524+00:00"); no mesmo formato, comparar texto é comparar instante
 * e os índices continuam valendo. Brasília é UTC-3 o ano todo (sem horário de verão desde 2019).
 * Tudo aqui recebe só colunas e constantes do código, nunca entrada do usuário (essa vai em parâmetro).
 */

/** Instante no formato gravado pelo Prisma, para parâmetros comparados com colunas DateTime. */
export function sqlTs(d: Date): string {
  return d.toISOString().replace("Z", "+00:00");
}

/** Agora (ou agora menos N dias) no formato gravado, calculado pelo banco. */
export function agoraSql(menosDias = 0): string {
  return menosDias ? `strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now', '-${Math.trunc(menosDias)} days')` : `strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now')`;
}

/** Dia civil em Brasília ('YYYY-MM-DD') de uma coluna DateTime. */
export function diaBrt(col: string): string {
  return `date(${col}, '-3 hours')`;
}

/** Dia do mês (1–31) em Brasília de uma coluna DateTime. */
export function diaDoMesBrt(col: string): string {
  return `CAST(strftime('%d', ${col}, '-3 hours') AS INTEGER)`;
}

/** Lista em parâmetro: `${col} IN ${emLista("$2")}` com JSON.stringify(lista) no $2 (o SQLite não tem array). */
export function emLista(param: string): string {
  return `(SELECT value FROM json_each(${param}))`;
}

/** Transação que conta como uso real (antecipação ou compra à vista; ver transactionClassifier.ts). */
export function usoRealSql(alias?: string): string {
  return `${alias ? `${alias}.` : ""}"usoTipo" IN ('ANTECIPACAO', 'COMPRA')`;
}

/** Só antecipação ("Débito Pix"), a que tem juros. */
export function antecipacaoSql(alias?: string): string {
  return `${alias ? `${alias}.` : ""}"usoTipo" = 'ANTECIPACAO'`;
}

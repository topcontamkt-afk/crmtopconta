import { tenantRaw } from "../config/db";

/**
 * Preenche `Client.diaCicloAbertura` a partir do cadastro de ciclos por cidade (CicloCidade), casando pela mesma
 * chave de cidade do Comércio. Cidade sem ciclo cadastrado (ou "sem cidade") fica sem dia. Só escreve onde o valor
 * muda, então é barato rodar a cada importação de clientes, ao salvar o cadastro e no job diário.
 */
export async function refreshCicloColumns(tenantId: string): Promise<number> {
  return tenantRaw.execute(
    `UPDATE "Client" SET "diaCicloAbertura" = s.dia
     FROM (
       SELECT c2.id, cc."diaAbertura" AS dia
       FROM "Client" c2
       LEFT JOIN "CicloCidade" cc ON cc."tenantId" = c2."tenantId" AND cc."cidadeKey" = c2."cidadeKey"
       WHERE c2."tenantId" = $1
     ) AS s
     WHERE "Client".id = s.id AND "Client"."tenantId" = $1 AND "Client"."diaCicloAbertura" IS NOT s.dia`,
    tenantId
  );
}

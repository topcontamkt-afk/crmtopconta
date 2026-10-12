import { tenantRaw } from "../config/db";
import { cidadeKeySql } from "./cidades";

/**
 * Preenche `Client.diaCicloAbertura` a partir do cadastro de ciclos por cidade (CicloCidade), casando pela mesma
 * chave de cidade do Comércio. Cidade sem ciclo cadastrado (ou "sem cidade") fica sem dia. Só escreve onde o valor
 * muda, então é barato rodar a cada importação de clientes, ao salvar o cadastro e no job diário.
 */
export async function refreshCicloColumns(tenantId: string): Promise<number> {
  return tenantRaw.execute(
    `UPDATE "Client" c SET "diaCicloAbertura" = s.dia
     FROM (
       SELECT c2.id, cc."diaAbertura" AS dia
       FROM "Client" c2
       LEFT JOIN "CicloCidade" cc ON cc."tenantId" = c2."tenantId" AND cc."cidadeKey" = ${cidadeKeySql('c2."cidade"')}
       WHERE c2."tenantId" = $1
     ) s
     WHERE c.id = s.id AND c."tenantId" = $1 AND c."diaCicloAbertura" IS DISTINCT FROM s.dia`,
    tenantId
  );
}

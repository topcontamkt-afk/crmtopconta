import { z } from "zod";
import { prisma } from "../../config/db";
import { MODELO_INICIAL, MODELO_VALIDO } from "./provedores/modelos";
import { NomeProvedor, PROVEDORES } from "./provedores/tipos";

/**
 * Provedor e modelo do assistente, escolhidos em Configurações por conta (Tenant.assistente). Sem escolha, vale o ambiente
 * (ASSISTENTE_PROVEDOR / ASSISTENTE_MODELO) e, sem ele, Claude com o modelo inicial. Ler nunca falha: se a coluna ainda não
 * existe no banco, cai no padrão (o assistente continua funcionando).
 */

export interface ConfigAssistente {
  provedor: NomeProvedor;
  modelo: string;
  origem: "conta" | "ambiente" | "padrao";
}

export const configSchema = z.object({ provedor: z.enum(PROVEDORES as [NomeProvedor, ...NomeProvedor[]]), modelo: z.string().trim().regex(MODELO_VALIDO, "ID de modelo inválido") }).strict();

export function configDoAmbiente(env: NodeJS.ProcessEnv = process.env): ConfigAssistente | null {
  const p = env.ASSISTENTE_PROVEDOR?.trim().toLowerCase();
  const m = env.ASSISTENTE_MODELO?.trim();
  const provedor = (PROVEDORES as string[]).includes(p ?? "") ? (p as NomeProvedor) : undefined;
  if (!provedor && !m) return null;
  const prov: NomeProvedor = provedor ?? "anthropic";
  return { provedor: prov, modelo: m && MODELO_VALIDO.test(m) ? m : MODELO_INICIAL[prov], origem: "ambiente" };
}

export async function lerConfig(tenantId: string): Promise<ConfigAssistente> {
  try {
    const row = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { assistente: true } });
    const parsed = configSchema.safeParse(row?.assistente);
    if (parsed.success) return { ...parsed.data, origem: "conta" };
  } catch (e) {
    console.error("[assistente] não foi possível ler a configuração da conta (coluna ainda não criada?):", e instanceof Error ? e.message : e);
  }
  return configDoAmbiente() ?? { provedor: "anthropic", modelo: MODELO_INICIAL.anthropic, origem: "padrao" };
}

export async function salvarConfig(tenantId: string, cfg: z.infer<typeof configSchema>): Promise<void> {
  await prisma.tenant.update({ where: { id: tenantId }, data: { assistente: cfg } });
}

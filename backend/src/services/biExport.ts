import { AppPrismaClient } from "../config/db";
import { writeSheetSummary } from "./googleSheets";
import { FAIXA_LABELS } from "./usage";

/**
 * Conector BI leve (Fase 3): monta um snapshot tabular (KPIs do dashboard + campanhas recentes)
 * e escreve na aba "CRM_Export" da mesma planilha usada para importação — dá pra conectar Google
 * Data Studio/Looker Studio direto nessa planilha como fonte, sem precisar de BigQuery.
 */
export async function exportTenantSummaryToSheet(prisma: AppPrismaClient, tenantId: string): Promise<{ exported: boolean; reason?: string }> {
  const connection = await prisma.sheetConnection.findFirst({ where: { tenantId, active: true } });
  if (!connection) return { exported: false, reason: "sem conexão de planilha ativa" };

  const [totalClientes, ativos, porFaixaRaw, agregados, campanhas] = await Promise.all([
    prisma.client.count({ where: { tenantId } }),
    prisma.client.count({ where: { tenantId, statusConta: "ATIVO" } }),
    prisma.client.groupBy({ by: ["faixaUso"], where: { tenantId }, _count: true }),
    prisma.client.aggregate({
      where: { tenantId },
      _sum: { limiteTotal: true, valorUtilizado: true, saldoDisponivel: true },
    }),
    prisma.campaign.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { name: true, channel: true, status: true, audienceCount: true, createdAt: true },
    }),
  ]);

  const geradoEm = new Date().toISOString();

  const resumoRows: (string | number)[][] = [
    ["Resumo CRM TopConta", "", "Gerado em", geradoEm],
    [],
    ["Métrica", "Valor"],
    ["Total de clientes", totalClientes],
    ["Clientes ativos", ativos],
    ["Limite total liberado", Number(agregados._sum.limiteTotal || 0)],
    ["Valor utilizado total", Number(agregados._sum.valorUtilizado || 0)],
    ["Saldo disponível total", Number(agregados._sum.saldoDisponivel || 0)],
    [],
    ["Clientes por faixa de uso"],
    ["Faixa", "Quantidade"],
    ...porFaixaRaw.map((f) => [FAIXA_LABELS[f.faixaUso as keyof typeof FAIXA_LABELS], f._count]),
    [],
    ["Últimas campanhas"],
    ["Nome", "Canal", "Status", "Público", "Criada em"],
    ...campanhas.map((c) => [c.name, c.channel, c.status, c.audienceCount ?? "", c.createdAt.toISOString()]),
  ];

  await writeSheetSummary(connection.sheetId, "CRM_Export", resumoRows);
  return { exported: true };
}

export async function exportAllTenantsSummary(prisma: AppPrismaClient) {
  const tenants = await prisma.tenant.findMany({ select: { id: true } });
  const results = [];
  for (const t of tenants) {
    try {
      results.push({ tenantId: t.id, ...(await exportTenantSummaryToSheet(prisma, t.id)) });
    } catch (e: any) {
      console.error(`[biExport] Falha ao exportar resumo do tenant ${t.id}:`, e);
      results.push({ tenantId: t.id, exported: false, reason: e.message });
    }
  }
  return results;
}

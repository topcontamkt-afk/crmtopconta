import { Prisma } from "@prisma/client";
import { AppPrismaClient } from "../config/db";

/** Recortes que o dashboard aceita (todos opcionais). */
export interface DashboardFilters {
  cidade?: string;
  empresaConveniada?: string;
}

export interface Kpis {
  totalClientes: number;
  ativos: number;
  inativos: number;
  bloqueados: number;
  semUso: number;
  quaseCompleto: number;
  limiteCompleto: number;
  limiteTotal: number;
  valorUtilizado: number;
  saldoDisponivel: number;
  ticketMedio: number;
  faixas: Record<string, number>;
}

export function clientWhere(tenantId: string, filters: DashboardFilters = {}): Prisma.ClientWhereInput {
  return {
    tenantId,
    ...(filters.cidade ? { cidade: filters.cidade } : {}),
    ...(filters.empresaConveniada ? { empresaConveniada: filters.empresaConveniada } : {}),
  };
}

/**
 * Fragmento SQL parametrizado para as queries raw do dashboard. `startIndex` é o próximo número
 * de placeholder livre ($n). Nomes de coluna são literais fixos; os valores sempre vão como
 * parâmetro — nunca interpolados.
 */
export function rawFilterSql(filters: DashboardFilters, startIndex: number): { sql: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  if (filters.cidade) {
    params.push(filters.cidade);
    parts.push(`AND "cidade" = $${startIndex + params.length - 1}`);
  }
  if (filters.empresaConveniada) {
    params.push(filters.empresaConveniada);
    parts.push(`AND "empresaConveniada" = $${startIndex + params.length - 1}`);
  }
  return { sql: parts.join(" "), params };
}

/** KPIs "de agora" da base, opcionalmente recortados por cidade/convênio. */
export async function computeKpis(prisma: AppPrismaClient, tenantId: string, filters: DashboardFilters = {}): Promise<Kpis> {
  const where = clientWhere(tenantId, filters);
  const [totalClientes, porStatus, porFaixa, agregados] = await Promise.all([
    prisma.client.count({ where }),
    prisma.client.groupBy({ by: ["statusConta"], where, _count: true }),
    prisma.client.groupBy({ by: ["faixaUso"], where, _count: true }),
    prisma.client.aggregate({
      where,
      _sum: { limiteTotal: true, valorUtilizado: true, saldoDisponivel: true },
      _avg: { valorUtilizado: true },
    }),
  ]);

  const status = (s: string) => porStatus.find((x) => x.statusConta === s)?._count ?? 0;
  const faixas: Record<string, number> = {};
  for (const f of porFaixa) faixas[f.faixaUso] = f._count;

  return {
    totalClientes,
    ativos: status("ATIVO"),
    inativos: status("INATIVO"),
    bloqueados: status("BLOQUEADO"),
    semUso: faixas["NAO_UTILIZOU"] ?? 0,
    quaseCompleto: faixas["QUASE_COMPLETO"] ?? 0,
    limiteCompleto: faixas["LIMITE_COMPLETO"] ?? 0,
    limiteTotal: Number(agregados._sum.limiteTotal ?? 0),
    valorUtilizado: Number(agregados._sum.valorUtilizado ?? 0),
    saldoDisponivel: Number(agregados._sum.saldoDisponivel ?? 0),
    ticketMedio: Number(agregados._avg.valorUtilizado ?? 0),
    faixas,
  };
}

/** Data civil de hoje no fuso de Brasília, como Date em UTC meia-noite (coluna @db.Date). */
export function todayBrt(now = new Date()): Date {
  const ymd = now.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }); // YYYY-MM-DD
  return new Date(`${ymd}T00:00:00.000Z`);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

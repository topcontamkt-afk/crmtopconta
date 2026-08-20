import cron from "node-cron";
import { prisma } from "../config/db";
import { runImport } from "./importService";
import { DEFAULT_COLUMN_MAPPING, fetchSheetRows } from "./googleSheets";

/**
 * Sincronização automática do Google Sheets (PRD — Must have).
 * Cada SheetConnection tem seu próprio cronSchedule (ex.: "0 6 * * 1,4" = 2x/semana).
 * Um único job mestre roda a cada hora e dispara as conexões cujo cron "bateria" naquele
 * minuto — abordagem simples e suficiente para o volume esperado no MVP; em produção isso
 * evolui para jobs agendados individualmente (ex.: BullMQ repeatable jobs).
 */
export function startScheduler() {
  cron.schedule("* * * * *", async () => {
    const connections = await prisma.sheetConnection.findMany({ where: { active: true } });
    const now = new Date();

    for (const conn of connections) {
      if (!cronMatchesNow(conn.cronSchedule, now)) continue;
      try {
        const rows = await fetchSheetRows(conn.sheetId, conn.sheetRange, (conn.columnMapping as any) || DEFAULT_COLUMN_MAPPING);
        await runImport(prisma, conn.tenantId, rows, "scheduler", "google_sheets", conn.sheetId);
        await prisma.sheetConnection.update({ where: { id: conn.id }, data: { lastSyncAt: now } });
      } catch (e) {
        // Falhas de sincronização automática ficam registradas no ImportJob (status FALHOU);
        // aqui apenas evitamos derrubar o processo do scheduler.
        console.error(`[scheduler] Falha ao sincronizar SheetConnection ${conn.id}:`, e);
      }
    }
  });
}

function cronMatchesNow(expr: string, date: Date): boolean {
  // Comparação simples campo a campo (minuto hora dia-mês mês dia-semana) — sem libs extras.
  const [min, hour, dom, month, dow] = expr.split(" ");
  const matches = (field: string, value: number) => field === "*" || field.split(",").map(Number).includes(value);
  return (
    matches(min, date.getMinutes()) &&
    matches(hour, date.getHours()) &&
    matches(dom, date.getDate()) &&
    matches(month, date.getMonth() + 1) &&
    matches(dow, date.getDay())
  );
}

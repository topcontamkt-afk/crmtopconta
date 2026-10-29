import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { d1LikeAdapter } from "../config/d1Like";
import { configureDatabase, prisma } from "../config/db";
import { migrationStatements } from "../config/d1Migrations";
import { runWithTenantContextAsync, withCrossTenantAccess } from "../config/tenantGuard";
import { ANCORA_CADEIA_TENANT, resetAnchorCache, verifyAuditChain } from "../services/auditIntegrity";
import { logAudit } from "./audit";

/**
 * LGPD 05-08 contra um SQLite de verdade (mesmas migrations do D1): sem fila em memória, gravações simultâneas do
 * mesmo tenant não bifurcam a cadeia, porque o índice único (tenantId, prevHash) recusa a segunda e logAudit tenta
 * de novo a partir do topo novo. Vale também para a corrida pela âncora de um tenant que ainda não tem cadeia.
 */

const dbFile = join(tmpdir(), `crm-auditoria-${randomUUID()}.sqlite`);
let tenantId = "";

beforeAll(async () => {
  configureDatabase(() => d1LikeAdapter(`file:${dbFile}`));
  await withCrossTenantAccess(async () => {
    for (const stmt of migrationStatements()) await prisma.$executeRawUnsafe(stmt);
    tenantId = (await prisma.tenant.create({ data: { name: "Auditoria" } })).id;
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(dbFile, { force: true });
});

it("20 gravações simultâneas, a partir de um tenant sem cadeia: uma âncora, cadeia linear e válida", async () => {
  resetAnchorCache();
  await runWithTenantContextAsync(tenantId, () =>
    Promise.all(Array.from({ length: 20 }, (_, i) => logAudit({ tenantId, action: "LOGIN_FALHA", details: { n: i } })))
  );

  const linhas = await runWithTenantContextAsync(tenantId, () =>
    prisma.auditLog.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { action: true, prevHash: true, hash: true } })
  );
  expect(linhas).toHaveLength(21);
  expect(linhas.filter((l) => l.action === ANCORA_CADEIA_TENANT)).toHaveLength(1);
  expect(linhas[0]).toMatchObject({ action: ANCORA_CADEIA_TENANT, prevHash: `GENESIS:${tenantId}` });
  linhas.slice(1).forEach((l, i) => expect(l.prevHash).toBe(linhas[i].hash));

  await expect(runWithTenantContextAsync(tenantId, () => verifyAuditChain(tenantId))).resolves.toEqual({
    valid: true,
    checked: 21,
    ancora: true,
    lacunasLegado: 0,
    redigidas: 0,
    bifurcacoes: 0,
  });
});

it("o banco recusa um segundo filho para o mesmo elo", async () => {
  await runWithTenantContextAsync(tenantId, async () => {
    const topo = await prisma.auditLog.findFirst({ orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { prevHash: true } });
    await expect(
      prisma.auditLog.create({ data: { tenantId, action: "FORJADA", prevHash: topo!.prevHash, hash: "x" } })
    ).rejects.toThrow();
  });
});

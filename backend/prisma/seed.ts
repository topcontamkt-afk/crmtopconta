import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import bcrypt from "bcryptjs";
import { PrismaClient } from "../src/generated/prisma/client";
import { hashCPF, maskCPF, normalizePhone } from "../src/services/masking";
import { computeUsage } from "../src/services/usage";
import { migrationsSql } from "../src/config/d1Migrations";

/**
 * Seed para o D1: monta os dados de demonstração com o Prisma num SQLite temporário (mesmas migrations
 * do D1) e grava `prisma/seed.sql` com os INSERTs, que o wrangler aplica (`npm run prisma:seed`).
 *
 * Usa o client sem a extensão de tenant (criar o próprio Tenant não tem contexto de tenant).
 * Senha dos usuários de demonstração: `SEED_PASSWORD`, ou `mudar123` (só para o ambiente local; a
 * homologação é pública, então lá sempre com SEED_PASSWORD).
 */
const OUT = join(__dirname, "seed.sql");
const dbFile = join(tmpdir(), `crm-seed-${randomUUID()}.sqlite`);

async function main() {
  const sqlite = new Database(dbFile);
  sqlite.exec(migrationsSql());
  sqlite.close();

  const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbFile}` }) });
  try {
    const tenant = await prisma.tenant.create({ data: { name: "TopConta Demo" } });

    const passwordHash = await bcrypt.hash(process.env.SEED_PASSWORD || "mudar123", 10);
    await prisma.user.createMany({
      data: [
        { tenantId: tenant.id, name: "Admin Demo", email: "admin@topconta.demo", passwordHash, role: "ADMIN" },
        { tenantId: tenant.id, name: "Operador Demo", email: "operador@topconta.demo", passwordHash, role: "OPERATOR" },
        { tenantId: tenant.id, name: "Analista Demo", email: "analista@topconta.demo", passwordHash, role: "ANALYST" },
      ],
    });

    const cidades = ["São Paulo", "Rio de Janeiro", "Belo Horizonte", "Curitiba", "Salvador"];
    const cpfs = ["52998224725", "11144477735", "39053344705", "16899535009", "84765374007"];

    for (let i = 0; i < 40; i++) {
      const limiteTotal = [0, 500, 1000, 2000, 5000][i % 5];
      const valorUtilizado = limiteTotal * [0, 0.1, 0.35, 0.6, 0.85, 1][i % 6];
      const { percentual, faixa } = computeUsage(limiteTotal, valorUtilizado);
      const phone = normalizePhone(`1199999${String(1000 + i).padStart(4, "0")}`);

      await prisma.client.create({
        data: {
          tenantId: tenant.id,
          externalId: `SEED-${i}`,
          nome: `Cliente Demo ${i + 1}`,
          telefone: phone || `+551199999${1000 + i}`,
          cpfHash: hashCPF(cpfs[i % cpfs.length], tenant.cpfSalt) + i, // garante unicidade no seed
          cpfMasked: maskCPF(cpfs[i % cpfs.length]),
          cidade: cidades[i % cidades.length],
          dataCadastro: new Date(Date.now() - i * 86400000),
          dataAberturaConta: new Date(Date.now() - (i + 30) * 86400000),
          limiteTotal,
          valorUtilizado,
          saldoDisponivel: limiteTotal - valorUtilizado,
          valorAntecipado: 0,
          dataUltimaUtilizacao: valorUtilizado > 0 ? new Date(Date.now() - i * 3600000) : null,
          percentualUtilizado: percentual,
          faixaUso: faixa,
          statusConta: i % 10 === 0 ? "INATIVO" : "ATIVO",
          origemCliente: "seed",
          autorizacaoComunicacao: i % 5 !== 0,
        },
      });
    }
  } finally {
    await prisma.$disconnect();
  }

  writeFileSync(OUT, dumpInserts(dbFile));
  rmSync(dbFile, { force: true });
  console.log(`Seed gravado em ${OUT}. Login: admin@topconta.demo / ${process.env.SEED_PASSWORD ? "(SEED_PASSWORD)" : "mudar123"}`);
}

/** INSERTs de todas as tabelas com linhas, na ordem em que foram criadas (pais antes dos filhos). */
function dumpInserts(file: string): string {
  const db = new Database(file, { readonly: true });
  const literal = (v: unknown): string => {
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number" || typeof v === "bigint") return String(v);
    if (Buffer.isBuffer(v)) return `X'${v.toString("hex")}'`;
    return `'${String(v).replace(/'/g, "''")}'`;
  };
  const linhas: string[] = [];
  const tabelas = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid`)
    .all() as { name: string }[];
  for (const { name } of tabelas) {
    for (const row of db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() as Record<string, unknown>[]) {
      const cols = Object.keys(row);
      linhas.push(`INSERT INTO "${name}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map((c) => literal(row[c])).join(", ")});`);
    }
  }
  db.close();
  return linhas.join("\n") + "\n";
}

main().catch((e) => {
  console.error(e);
  rmSync(dbFile, { force: true });
  process.exit(1);
});

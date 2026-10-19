import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { migrationsSql } from "./d1Migrations";

/**
 * As migrations de `migrations/` (escritas à mão quando o Prisma geraria reconstrução de tabela, perigosa no
 * D1: sem `PRAGMA foreign_keys=OFF`, o DROP TABLE dispara as cascatas) precisam chegar exatamente ao
 * `schema.prisma`. Aplica todas num SQLite vazio e pede ao Prisma a diferença para o schema: tem de ser nenhuma.
 */
it("migrations aplicadas em ordem = schema.prisma", () => {
  const dir = mkdtempSync(join(tmpdir(), "crm-migr-"));
  try {
    const db = join(dir, "db.sqlite");
    const sqlite = new Database(db);
    sqlite.exec(migrationsSql());
    sqlite.close();
    const config = join(dir, "prisma.config.ts");
    const schema = resolve(__dirname, "../../prisma/schema.prisma");
    writeFileSync(
      config,
      `export default { schema: ${JSON.stringify(schema)}, datasource: { url: ${JSON.stringify(`file:${db}`)} } };\n`
    );
    const bin = resolve(__dirname, "../../node_modules/.bin/prisma");
    const out = execFileSync(bin, ["migrate", "diff", "--config", config, "--from-config-datasource", "--to-schema", schema, "--script"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(out.replace(/^--.*$/gm, "").trim()).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "../../migrations");

// Só para o Node (seed e testes de integração); o Worker não importa este arquivo.

/** SQL de todas as migrations do D1 (migrations/NNNN_*.sql), na ordem em que o wrangler as aplica. */
export function migrationsSql(): string {
  return readdirSync(DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()
    .map((f) => readFileSync(join(DIR, f), "utf8"))
    .join("\n");
}

/** As mesmas migrations separadas em comandos, para quem só executa um por vez ($executeRawUnsafe). */
export function migrationStatements(): string[] {
  return migrationsSql()
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

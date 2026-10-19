import { defineConfig } from "prisma/config";

// O Prisma 7 exige uma URL até para `migrate diff --from-empty`; sem ela a saída sai vazia e sem
// erro. É um SQLite local descartável: as migrations vão para o D1 pelo wrangler
// (`wrangler d1 migrations apply`), nunca por esta URL.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "migrations" },
  datasource: { url: "file:./prisma/.diff.sqlite" },
});

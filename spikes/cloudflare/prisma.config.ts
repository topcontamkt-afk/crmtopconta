import { defineConfig } from "prisma/config";

// O D1 não tem URL; o schema engine do Prisma 7 exige uma fonte mesmo para o `migrate diff`,
// então usa um SQLite local descartável (ignorado pelo git).
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: "file:./prisma/diff.sqlite" },
});

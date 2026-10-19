/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/src/**/*.test.ts"],
  // envio simulado por padrão nos testes (MESSAGING_MODE=mock), como no ambiente local
  setupFiles: ["<rootDir>/test/setupEnv.js"],
  moduleNameMapper: {
    // client do Prisma 7 gerado para a Cloudflare (ver test/prismaWasmModule.js)
    "^\\./query_compiler_fast_bg\\.wasm\\?module$": "<rootDir>/test/prismaWasmModule.js",
    // a "cola" do WASM gerada é ESM; o @prisma/client traz a mesma em CommonJS
    "^\\./query_compiler_fast_bg\\.js$": "@prisma/client/runtime/query_compiler_fast_bg.sqlite.js",
  },
};

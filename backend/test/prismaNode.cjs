// Pré-carregamento (`node -r` / `ts-node -r`) para usar no Node o client do Prisma 7 gerado com
// runtime = "cloudflare" (scripts como o seed). Faz o mesmo que o moduleNameMapper do jest.config.js:
// o `.wasm?module` vem de test/prismaWasmModule.js e a "cola" ESM do WASM vem da cópia CommonJS
// que o @prisma/client traz.
const Module = require("node:module");
const { join } = require("node:path");

const MAP = {
  "./query_compiler_fast_bg.wasm?module": join(__dirname, "prismaWasmModule.js"),
  "./query_compiler_fast_bg.js": require.resolve("@prisma/client/runtime/query_compiler_fast_bg.sqlite.js"),
};

const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return resolve.call(this, MAP[request] ?? request, ...rest);
};

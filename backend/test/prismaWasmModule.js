// Jest (Node) não importa `.wasm?module` como o wrangler/workerd. O client gerado com
// runtime = "cloudflare" pede o compilador de queries assim; aqui ele é lido do disco.
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const wasm = readFileSync(join(__dirname, "../src/generated/prisma/internal/query_compiler_fast_bg.wasm"));
module.exports = { __esModule: true, default: new WebAssembly.Module(wasm) };

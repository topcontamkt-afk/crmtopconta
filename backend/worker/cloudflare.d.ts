// O backend é tipado com os tipos do Node; os globais de @cloudflare/workers-types conflitam com eles
// (Buffer, crypto, fetch). O Worker importa os tipos da Cloudflare por nome (`@cloudflare/workers-types`
// sem globais) e declara aqui só os módulos `cloudflare:*` que usa.
declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
  export function waitUntil(promise: Promise<unknown>): void;
}

declare module "cloudflare:node" {
  export function httpServerHandler(options: { port: number }): unknown;
}

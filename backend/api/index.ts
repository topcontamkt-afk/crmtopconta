import app from "../src/app";

/**
 * Entry point da função serverless da Vercel: um único handler "catch-all" que recebe todas as
 * requisições (ver vercel.json → rewrites) e delega para o Express app normalmente. O Express
 * app em si já é compatível com a assinatura (req, res) esperada pelo runtime Node da Vercel,
 * então não é necessário nenhum adaptador extra.
 */
export default app;

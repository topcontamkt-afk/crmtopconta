// Ambiente dos testes: canais sem credencial caem no adaptador simulado (ver resolveProviders em campaignQueue.ts).
process.env.MESSAGING_MODE = process.env.MESSAGING_MODE || "mock";

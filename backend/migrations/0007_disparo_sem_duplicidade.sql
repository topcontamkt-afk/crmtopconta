-- Disparo sem duplicidade: trava por campanha e reserva dos itens da fila (services/dispatchGuard.ts).
ALTER TABLE "MessageEvent" ADD COLUMN "claimToken" TEXT;
ALTER TABLE "MessageEvent" ADD COLUMN "claimedAt" DATETIME;
ALTER TABLE "Campaign" ADD COLUMN "dispatchToken" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "dispatchUntil" DATETIME;

-- Disparo sem duplicidade: trava por empresa e reserva dos itens da fila (services/dispatchGuard.ts).
ALTER TABLE "MessageEvent" ADD COLUMN "claimToken" TEXT;
ALTER TABLE "MessageEvent" ADD COLUMN "claimedAt" DATETIME;
ALTER TABLE "Tenant" ADD COLUMN "dispatchToken" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "dispatchUntil" DATETIME;
ALTER TABLE "Tenant" ADD COLUMN "dispatchCampaignId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_tenantId_prevHash_key" ON "AuditLog"("tenantId", "prevHash");

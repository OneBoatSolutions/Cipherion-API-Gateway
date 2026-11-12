-- CreateIndex
CREATE INDEX "auditEvent_action_createdAt_idx" ON "auditEvent"("action", "createdAt");

-- CreateIndex
CREATE INDEX "envelopeDelivery_createdAt_idx" ON "envelopeDelivery"("createdAt");

-- CreateIndex
CREATE INDEX "group_deletedAt_idx" ON "group"("deletedAt");

-- CreateIndex
CREATE INDEX "project_deletedAt_idx" ON "project"("deletedAt");

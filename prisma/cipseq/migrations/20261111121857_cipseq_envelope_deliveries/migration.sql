-- CreateEnum
CREATE TYPE "CryptoOperation" AS ENUM ('ENCRYPT', 'DECRYPT');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('APPROVED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "CryptoDataKind" AS ENUM ('TEXT', 'FILE', 'STREAM', 'OTHER');

-- CreateEnum
CREATE TYPE "CryptoOutcome" AS ENUM ('SUCCESS', 'FAILED');

-- CreateTable
CREATE TABLE "envelopeDelivery" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "auditEventId" UUID NOT NULL,
    "operation" "CryptoOperation" NOT NULL,
    "status" "DeliveryStatus" NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "groupId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "gdekVersion" INTEGER NOT NULL,
    "certificateSerial" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataKind" "CryptoDataKind",
    "mimeType" TEXT,
    "sizeBytes" BIGINT,
    "fileNameHash" TEXT,
    "outcome" "CryptoOutcome",
    "errorCode" TEXT,
    "durationMs" INTEGER,
    "occurredAt" TIMESTAMP(3),

    CONSTRAINT "envelopeDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "envelopeDelivery_requestId_key" ON "envelopeDelivery"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "envelopeDelivery_auditEventId_key" ON "envelopeDelivery"("auditEventId");

-- CreateIndex
CREATE INDEX "envelopeDelivery_projectId_createdAt_idx" ON "envelopeDelivery"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "envelopeDelivery_groupId_createdAt_idx" ON "envelopeDelivery"("groupId", "createdAt");

-- CreateIndex
CREATE INDEX "envelopeDelivery_userId_createdAt_idx" ON "envelopeDelivery"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "envelopeDelivery_deviceId_createdAt_idx" ON "envelopeDelivery"("deviceId", "createdAt");

-- AddForeignKey
ALTER TABLE "envelopeDelivery" ADD CONSTRAINT "envelopeDelivery_auditEventId_fkey" FOREIGN KEY ("auditEventId") REFERENCES "auditEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "envelopeDelivery" ADD CONSTRAINT "envelopeDelivery_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "envelopeDelivery" ADD CONSTRAINT "envelopeDelivery_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "envelopeDelivery" ADD CONSTRAINT "envelopeDelivery_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

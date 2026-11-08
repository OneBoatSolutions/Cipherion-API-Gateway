-- CreateEnum
CREATE TYPE "DeviceCertificateOperation" AS ENUM ('ENROL', 'RENEW');

-- CreateTable
CREATE TABLE "deviceCertificate" (
    "serialNumber" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "csrSha256" TEXT NOT NULL,
    "publicKeySha256" TEXT NOT NULL,
    "certificatePem" TEXT NOT NULL,
    "notBefore" TIMESTAMP(3) NOT NULL,
    "notAfter" TIMESTAMP(3) NOT NULL,
    "issuedVia" "DeviceCertificateOperation" NOT NULL,
    "renewedFromSerial" TEXT,
    "supersededAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deviceCertificate_pkey" PRIMARY KEY ("serialNumber")
);

-- CreateTable
CREATE TABLE "deviceCertificateAttempt" (
    "id" UUID NOT NULL,
    "deviceId" TEXT NOT NULL,
    "operation" "DeviceCertificateOperation" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deviceCertificateAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deviceCertificateNotice" (
    "id" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "DeviceCertificateOperation" NOT NULL,
    "deviceId" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dismissedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
    "nextDeliveryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deviceCertificateNotice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deviceCertificate_deviceId_createdAt_idx" ON "deviceCertificate"("deviceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "deviceCertificate_deviceId_csrSha256_key" ON "deviceCertificate"("deviceId", "csrSha256");

-- CreateIndex
CREATE INDEX "deviceCertificateAttempt_deviceId_createdAt_idx" ON "deviceCertificateAttempt"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "deviceCertificateNotice_userId_dismissedAt_idx" ON "deviceCertificateNotice"("userId", "dismissedAt");

-- CreateIndex
CREATE INDEX "deviceCertificateNotice_deliveredAt_nextDeliveryAt_idx" ON "deviceCertificateNotice"("deliveredAt", "nextDeliveryAt");

-- AddForeignKey
ALTER TABLE "deviceCertificate" ADD CONSTRAINT "deviceCertificate_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deviceCertificateAttempt" ADD CONSTRAINT "deviceCertificateAttempt_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One current certificate per device. Prisma can't express a partial index, so
-- this is written by hand. A retired certificate has supersededAt or revokedAt set.
CREATE UNIQUE INDEX "deviceCertificate_one_current" ON "deviceCertificate" ("deviceId")
  WHERE "supersededAt" IS NULL AND "revokedAt" IS NULL;

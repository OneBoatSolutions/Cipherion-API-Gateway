-- CreateEnum
CREATE TYPE "SystemService" AS ENUM ('AUTH_DATABASE', 'CIPSEQ_DATABASE', 'REDIS', 'KMS', 'SMTP');

-- CreateEnum
CREATE TYPE "SystemEventKind" AS ENUM ('CONNECTION_ESTABLISHED', 'CONNECTION_LOST', 'CONNECTION_RESTORED');

-- CreateTable
CREATE TABLE "systemEvent" (
    "id" TEXT NOT NULL,
    "service" "SystemService" NOT NULL,
    "kind" "SystemEventKind" NOT NULL,
    "reason" TEXT,
    "metadata" JSONB,
    "instance" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "systemEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "systemEvent_occurredAt_idx" ON "systemEvent"("occurredAt");

-- CreateIndex
CREATE INDEX "systemEvent_service_occurredAt_idx" ON "systemEvent"("service", "occurredAt");

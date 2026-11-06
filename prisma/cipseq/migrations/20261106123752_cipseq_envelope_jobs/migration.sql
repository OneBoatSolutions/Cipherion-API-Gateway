/*
  Warnings:

  - You are about to drop the `projectRemovalRequest` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "EnvelopeJobKind" AS ENUM ('ROTATION', 'APPROVAL', 'RENEWAL');

-- CreateEnum
CREATE TYPE "EnvelopeJobStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "EnvelopeJobFailure" AS ENUM ('WRONG_PASSPHRASE', 'KMS_UNAVAILABLE', 'INTERRUPTED');

-- DropForeignKey
ALTER TABLE "projectRemovalRequest" DROP CONSTRAINT "projectRemovalRequest_projectId_fkey";

-- DropForeignKey
ALTER TABLE "projectRemovalRequest" DROP CONSTRAINT "projectRemovalRequest_targetDeviceId_fkey";

-- DropTable
DROP TABLE "projectRemovalRequest";

-- DropEnum
DROP TYPE "RemovalRequestStatus";

-- CreateTable
CREATE TABLE "envelopeJob" (
    "groupId" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "kind" "EnvelopeJobKind" NOT NULL,
    "gdekVersion" INTEGER NOT NULL,
    "status" "EnvelopeJobStatus" NOT NULL,
    "failureReason" "EnvelopeJobFailure",
    "envelopeCount" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "lastActiveAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),

    CONSTRAINT "envelopeJob_pkey" PRIMARY KEY ("groupId")
);

-- AddForeignKey
ALTER TABLE "envelopeJob" ADD CONSTRAINT "envelopeJob_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

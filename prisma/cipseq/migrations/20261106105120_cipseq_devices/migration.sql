/*
  Warnings:

  - You are about to drop the `groupMemberRemovalRequest` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `projectMember` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "GroupDeviceStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'REVOKED');

-- AlterEnum. The type is replaced because a value added with ADD VALUE can't be
-- used in the transaction that adds it, and existing rows have to be converted.
ALTER TYPE "GroupRole" RENAME TO "GroupRole_old";
CREATE TYPE "GroupRole" AS ENUM ('ADMIN', 'ACTING_ADMIN', 'MEMBER');
ALTER TABLE "groupMember" ALTER COLUMN "role" TYPE TEXT USING "role"::TEXT;

-- ADMIN now means the project admin only. A group keeps one acting admin, the
-- member who joined first; there's no record of when a role was assigned.
WITH "acting" AS (
  SELECT
    m."groupId",
    m."userId",
    ROW_NUMBER() OVER (
      PARTITION BY m."groupId" ORDER BY m."createdAt", m."userId"
    ) AS "position"
  FROM "groupMember" m
  JOIN "group" g ON g."id" = m."groupId"
  JOIN "project" p ON p."id" = g."projectId"
  WHERE m."role" = 'ADMIN' AND m."userId" <> p."adminUserId"
)
UPDATE "groupMember" m
SET "role" = CASE WHEN a."position" = 1 THEN 'ACTING_ADMIN' ELSE 'MEMBER' END
FROM "acting" a
WHERE m."groupId" = a."groupId" AND m."userId" = a."userId";

ALTER TABLE "groupMember" ALTER COLUMN "role" TYPE "GroupRole" USING "role"::"GroupRole";
DROP TYPE "GroupRole_old";

-- DropForeignKey
ALTER TABLE "groupMemberRemovalRequest" DROP CONSTRAINT "groupMemberRemovalRequest_groupId_fkey";

-- DropForeignKey
ALTER TABLE "projectMember" DROP CONSTRAINT "projectMember_projectId_fkey";

-- DropTable
DROP TABLE "groupMemberRemovalRequest";

-- DropTable
DROP TABLE "projectMember";

-- CreateTable
CREATE TABLE "projectRemovalRequest" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "targetUserId" TEXT,
    "targetDeviceId" TEXT,
    "requestedByUserId" TEXT NOT NULL,
    "status" "RemovalRequestStatus" NOT NULL,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projectRemovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT,
    "publicKey" TEXT NOT NULL,
    "status" "DeviceStatus" NOT NULL DEFAULT 'ACTIVE',
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "groupDevice" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "deviceId" TEXT NOT NULL,
    "status" "GroupDeviceStatus" NOT NULL,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "groupDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deviceEnvelope" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "deviceId" TEXT NOT NULL,
    "envelopeVersion" INTEGER NOT NULL,
    "envelopeJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "deviceEnvelope_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "projectRemovalRequest_projectId_status_idx" ON "projectRemovalRequest"("projectId", "status");

-- CreateIndex
CREATE INDEX "device_userId_idx" ON "device"("userId");

-- CreateIndex
CREATE INDEX "groupDevice_deviceId_status_idx" ON "groupDevice"("deviceId", "status");

-- CreateIndex
CREATE INDEX "groupDevice_groupId_status_idx" ON "groupDevice"("groupId", "status");

-- CreateIndex
CREATE INDEX "deviceEnvelope_deviceId_idx" ON "deviceEnvelope"("deviceId");

-- CreateIndex
CREATE INDEX "deviceEnvelope_groupId_envelopeVersion_idx" ON "deviceEnvelope"("groupId", "envelopeVersion");

-- AddForeignKey
ALTER TABLE "projectRemovalRequest" ADD CONSTRAINT "projectRemovalRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projectRemovalRequest" ADD CONSTRAINT "projectRemovalRequest_targetDeviceId_fkey" FOREIGN KEY ("targetDeviceId") REFERENCES "device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "groupDevice" ADD CONSTRAINT "groupDevice_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "groupDevice" ADD CONSTRAINT "groupDevice_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deviceEnvelope" ADD CONSTRAINT "deviceEnvelope_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deviceEnvelope" ADD CONSTRAINT "deviceEnvelope_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written: Prisma's schema can't express these.
ALTER TABLE "projectRemovalRequest" ADD CONSTRAINT "projectRemovalRequest_one_target"
  CHECK (num_nonnulls("targetUserId", "targetDeviceId") = 1);

CREATE UNIQUE INDEX "projectRemovalRequest_one_pending_member" ON "projectRemovalRequest" ("projectId", "targetUserId")
  WHERE "status" = 'PENDING_APPROVAL' AND "targetUserId" IS NOT NULL;

CREATE UNIQUE INDEX "projectRemovalRequest_one_pending_device" ON "projectRemovalRequest" ("projectId", "targetDeviceId")
  WHERE "status" = 'PENDING_APPROVAL' AND "targetDeviceId" IS NOT NULL;

CREATE UNIQUE INDEX "groupDevice_one_open" ON "groupDevice" ("groupId", "deviceId")
  WHERE "status" IN ('PENDING_APPROVAL', 'APPROVED');

CREATE UNIQUE INDEX "deviceEnvelope_one_live" ON "deviceEnvelope" ("groupId", "deviceId", "envelopeVersion")
  WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "groupMember_one_acting_admin" ON "groupMember" ("groupId")
  WHERE "role" = 'ACTING_ADMIN';
